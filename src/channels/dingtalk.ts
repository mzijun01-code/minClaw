/**
 * DingTalkChannel — DingTalk via Stream Mode (WebSocket).
 *
 * Implements DingTalk's stream protocol directly using WebSocket.
 * No extra SDK required — only the `ws` package.
 *
 * Config env vars:
 *   DINGTALK_CLIENT_ID      — App Key / Client ID (required)
 *   DINGTALK_CLIENT_SECRET  — App Secret (required)
 *   DINGTALK_ALLOW_FROM     — comma-separated staffId list (default: "*")
 */

import https from 'node:https';
import type { OutboundMessage } from '../types/index.js';
import type { MessageBus } from '../bus/queue.js';
import { BaseChannel, type ChannelConfig } from './base.js';

const DINGTALK_GATEWAY = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const DINGTALK_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const DINGTALK_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

interface StreamTicket {
  endpoint: string;
  ticket: string;
}

export class DingTalkChannel extends BaseChannel {
  readonly name = 'dingtalk';

  private readonly _clientId: string;
  private readonly _clientSecret: string;
  private _ws: import('ws').WebSocket | null = null;
  private _accessToken: string | null = null;
  private _tokenExpiry = 0;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ChannelConfig, bus: MessageBus) {
    super(config, bus);
    this._clientId = process.env['DINGTALK_CLIENT_ID'] ?? '';
    this._clientSecret = process.env['DINGTALK_CLIENT_SECRET'] ?? '';
  }

  async start(): Promise<void> {
    if (!this._clientId || !this._clientSecret) {
      console.error('[dingtalk] client_id and client_secret not configured');
      return;
    }

    let WS: typeof import('ws').WebSocket;
    try {
      const wsModule = await import('ws');
      WS = wsModule.WebSocket ?? (wsModule as unknown as { default: { WebSocket: typeof import('ws').WebSocket } }).default.WebSocket;
    } catch {
      console.error('[dingtalk] ws package not installed. Run: npm install ws');
      return;
    }

    this._running = true;
    console.log('[dingtalk] Starting stream mode...');

    while (this._running) {
      try {
        await this._connectStream(WS);
      } catch (e) {
        console.warn('[dingtalk] Stream error:', e);
      }
      if (this._running) {
        console.log('[dingtalk] Reconnecting in 5s...');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    this._ws?.close();
    this._ws = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const token = await this._getAccessToken();
    if (!token) return;

    if (msg.content?.trim()) {
      await this._sendMarkdown(token, msg.chatId, msg.content.trim());
    }
  }

  private async _connectStream(WS: typeof import('ws').WebSocket): Promise<void> {
    const ticket = await this._getStreamTicket();
    const ws = new WS(`${ticket.endpoint}?ticket=${ticket.ticket}`);
    this._ws = ws as unknown as import('ws').WebSocket;

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        console.log('[dingtalk] WebSocket connected');
        // Send heartbeat every 10s
        this._pingTimer = setInterval(() => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'SYSTEM', headers: { contentType: 'application/json' }, data: JSON.stringify({ type: 'ping' }) }));
          }
        }, 10000);
      });

      ws.on('message', async (raw: Buffer | string) => {
        try {
          const frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8')) as Record<string, unknown>;
          const headers = (frame['headers'] as Record<string, string>) ?? {};
          const msgType = headers['type'] ?? (frame['type'] as string);

          if (msgType === 'SYSTEM') {
            // Heartbeat pong or system messages
            return;
          }

          if (msgType === 'EVENT' || headers['eventType'] === 'im_message_receive_v1') {
            const data = JSON.parse((frame['data'] as string) ?? '{}') as Record<string, unknown>;
            await this._onMessage(data).catch((e) =>
              console.error('[dingtalk] Message handler error:', e),
            );
            // Acknowledge
            ws.send(JSON.stringify({
              code: 200,
              headers: frame['headers'],
              message: 'OK',
              data: '{}',
            }));
          }
        } catch (e) {
          console.error('[dingtalk] Parse error:', e);
        }
      });

      ws.on('close', resolve);
      ws.on('error', reject);
    });

    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  private async _getStreamTicket(): Promise<StreamTicket> {
    const body = JSON.stringify({
      clientId: this._clientId,
      clientSecret: this._clientSecret,
    });

    return new Promise<StreamTicket>((resolve, reject) => {
      const u = new URL(DINGTALK_GATEWAY);
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c: string) => { data += c; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data) as Record<string, unknown>;
              resolve({ endpoint: json['endpoint'] as string, ticket: json['ticket'] as string });
            } catch { reject(new Error('Invalid ticket response')); }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async _getAccessToken(): Promise<string | null> {
    if (this._accessToken && Date.now() < this._tokenExpiry) {
      return this._accessToken;
    }

    const body = JSON.stringify({
      appKey: this._clientId,
      appSecret: this._clientSecret,
    });

    return new Promise<string | null>((resolve) => {
      const u = new URL(DINGTALK_TOKEN_URL);
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c: string) => { data += c; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data) as Record<string, unknown>;
              this._accessToken = json['accessToken'] as string;
              this._tokenExpiry = Date.now() + ((json['expireIn'] as number) ?? 7200) * 1000 - 60000;
              resolve(this._accessToken);
            } catch { resolve(null); }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  }

  private async _sendMarkdown(token: string, userId: string, content: string): Promise<void> {
    const body = JSON.stringify({
      robotCode: this._clientId,
      userIds: [userId],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ text: content, title: 'minbot' }),
    });

    await new Promise<void>((resolve, reject) => {
      const u = new URL(DINGTALK_SEND_URL);
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-acs-dingtalk-access-token': token,
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
      req.write(body);
      req.end();
    });
  }

  private async _onMessage(data: Record<string, unknown>): Promise<void> {
    // DingTalk stream message format
    const senderStaffId = (data['senderStaffId'] as string) ?? (data['senderId'] as string) ?? '';
    const senderNick = (data['senderNick'] as string) ?? 'Unknown';
    const textContent = (
      (data['text'] as Record<string, string> | null)?.['content']
    ) ?? '';
    const content = textContent.trim();

    if (!content) return;

    console.log(`[dingtalk] Message from ${senderNick} (${senderStaffId}): ${content.slice(0, 80)}`);

    await this._handleMessage({
      senderId: senderStaffId,
      chatId: senderStaffId, // Private chat: chat_id == sender_id
      content,
      metadata: { senderName: senderNick, platform: 'dingtalk' },
    });
  }
}
