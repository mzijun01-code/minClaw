/**
 * DiscordChannel — Discord Gateway WebSocket + REST API.
 *
 * Uses the `ws` package for the gateway connection.
 *
 * Config env vars:
 *   DISCORD_TOKEN       — bot token (required)
 *   DISCORD_INTENTS     — gateway intents bitmask
 *                         default: 33280 = GUILDS(1) + GUILD_MESSAGES(512) + MESSAGE_CONTENT(32768) + DIRECT_MESSAGES(4096)
 *   DISCORD_ALLOW_FROM  — comma-separated user IDs (default: "*")
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { OutboundMessage } from '../types/index.js';
import type { MessageBus } from '../bus/queue.js';
import { BaseChannel, type ChannelConfig } from './base.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const MAX_MESSAGE_LEN = 2000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function splitMessage(content: string, maxLen = MAX_MESSAGE_LEN): string[] {
  if (!content) return [];
  if (content.length <= maxLen) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > maxLen) {
    let pos = remaining.slice(0, maxLen).lastIndexOf('\n');
    if (pos <= 0) pos = remaining.slice(0, maxLen).lastIndexOf(' ');
    if (pos <= 0) pos = maxLen;
    chunks.push(remaining.slice(0, pos));
    remaining = remaining.slice(pos).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class DiscordChannel extends BaseChannel {
  readonly name = 'discord';

  private _ws: import('ws').WebSocket | null = null;
  private _seq: number | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly _token: string;
  private readonly _intents: number;

  constructor(config: ChannelConfig, bus: MessageBus) {
    super(config, bus);
    this._token = process.env['DISCORD_TOKEN'] ?? '';
    this._intents = parseInt(process.env['DISCORD_INTENTS'] ?? '33280', 10);
  }

  async start(): Promise<void> {
    if (!this._token) {
      console.error('[discord] Bot token not configured');
      return;
    }

    let WS: typeof import('ws').WebSocket;
    try {
      const wsModule = await import('ws');
      WS = wsModule.WebSocket;
    } catch {
      console.error('[discord] ws package not installed. Run: npm install ws');
      return;
    }

    this._running = true;
    console.log('[discord] Connecting to gateway...');

    while (this._running) {
      try {
        await this._connectGateway(WS);
      } catch (e) {
        console.warn('[discord] Gateway error:', e);
      }
      if (this._running) {
        console.log('[discord] Reconnecting in 5s...');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    this._clearHeartbeat();
    for (const [cid] of this._typingTimers) this._stopTyping(cid);
    this._ws?.close();
    this._ws = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    this._stopTyping(msg.chatId);

    const url = `${DISCORD_API_BASE}/channels/${msg.chatId}/messages`;
    const headers: Record<string, string> = {
      Authorization: `Bot ${this._token}`,
      'Content-Type': 'application/json',
    };

    const chunks = splitMessage(msg.content ?? '');
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { content: chunks[i] };
      if (i === 0 && msg.replyTo) {
        body['message_reference'] = { message_id: msg.replyTo };
        body['allowed_mentions'] = { replied_user: false };
      }
      await this._restPost(url, headers, body).catch(
        (e) => console.error('[discord] Send error:', e),
      );
    }
  }

  private async _connectGateway(WS: typeof import('ws').WebSocket): Promise<void> {
    const ws = new WS('wss://gateway.discord.gg/?v=10&encoding=json');
    this._ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data: Buffer | string) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(
            typeof data === 'string' ? data : (data as Buffer).toString('utf-8'),
          ) as Record<string, unknown>;
        } catch {
          return;
        }

        const op = payload['op'] as number;
        const t = payload['t'] as string | null;
        const s = payload['s'] as number | null;
        const d = payload['d'] as Record<string, unknown> | null;

        if (s !== null) this._seq = s;

        if (op === 10) {
          const interval = ((d ?? {}) as Record<string, number>)['heartbeat_interval'] ?? 45000;
          this._startHeartbeat(ws, interval);
          this._identify(ws);
        } else if (op === 0 && t === 'READY') {
          console.log('[discord] Gateway READY');
        } else if (op === 0 && t === 'MESSAGE_CREATE') {
          this._handleMessageCreate(d ?? {}).catch(
            (e) => console.error('[discord] Message handler error:', e),
          );
        } else if (op === 7 || op === 9) {
          ws.close();
        }
      });

      ws.on('close', resolve);
      ws.on('error', reject);
    });

    this._clearHeartbeat();
  }

  private _identify(ws: import('ws').WebSocket): void {
    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: this._token,
        intents: this._intents,
        properties: { os: 'minbot', browser: 'minbot', device: 'minbot' },
      },
    }));
  }

  private _startHeartbeat(ws: import('ws').WebSocket, intervalMs: number): void {
    this._clearHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ op: 1, d: this._seq }));
      }
    }, intervalMs);
  }

  private _clearHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private async _handleMessageCreate(payload: Record<string, unknown>): Promise<void> {
    const author = (payload['author'] as Record<string, unknown>) ?? {};
    if (author['bot']) return;

    const senderId = String(author['id'] ?? '');
    const channelId = String(payload['channel_id'] ?? '');
    if (!senderId || !channelId) return;

    if (!this.isAllowed(senderId)) return;

    const contentParts: string[] = [];
    const text = (payload['content'] as string) ?? '';
    if (text) contentParts.push(text);

    const mediaPaths: string[] = [];
    const mediaDir = path.join(os.homedir(), '.minbot', 'media');

    for (const attachment of ((payload['attachments'] as Record<string, unknown>[]) ?? [])) {
      const url = attachment['url'] as string;
      const filename = (attachment['filename'] as string) ?? 'attachment';
      const size = (attachment['size'] as number) ?? 0;

      if (!url) continue;
      if (size > MAX_ATTACHMENT_BYTES) {
        contentParts.push(`[attachment: ${filename} - too large]`);
        continue;
      }

      try {
        fs.mkdirSync(mediaDir, { recursive: true });
        const safeFilename = filename.replace(/\//g, '_');
        const filePath = path.join(mediaDir, `${attachment['id'] ?? 'file'}_${safeFilename}`);
        await this._downloadUrl(url, filePath);
        mediaPaths.push(filePath);
        contentParts.push(`[attachment: ${filePath}]`);
      } catch {
        contentParts.push(`[attachment: ${filename} - download failed]`);
      }
    }

    const replyTo =
      ((payload['referenced_message'] as Record<string, unknown> | null)?.['id'] as string) ??
      undefined;

    this._startTyping(channelId);

    await this._handleMessage({
      senderId,
      chatId: channelId,
      content: contentParts.join('\n') || '[empty message]',
      media: mediaPaths,
      metadata: { messageId: payload['id'], guildId: payload['guild_id'], replyTo },
    });
  }

  private _startTyping(channelId: string): void {
    this._stopTyping(channelId);
    const send = () => {
      const url = `${DISCORD_API_BASE}/channels/${channelId}/typing`;
      this._restPost(url, { Authorization: `Bot ${this._token}` }, {}).catch(() => {/* ignore */});
    };
    send();
    this._typingTimers.set(channelId, setInterval(send, 8000));
  }

  private _stopTyping(channelId: string): void {
    const t = this._typingTimers.get(channelId);
    if (t) { clearInterval(t); this._typingTimers.delete(channelId); }
  }

  private _restPost(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const u = new URL(url);
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            if ((res.statusCode ?? 200) < 300) resolve();
            else reject(new Error(`HTTP ${res.statusCode}`));
          });
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  private _downloadUrl(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https.get(url, (res) => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    });
  }
}
