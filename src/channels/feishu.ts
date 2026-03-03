/**
 * FeishuChannel — Feishu/Lark using WebSocket long connection via @larksuiteoapi/node-sdk.
 *
 * Config env vars:
 *   FEISHU_APP_ID         — App ID from Feishu Open Platform (required)
 *   FEISHU_APP_SECRET     — App Secret (required)
 *   FEISHU_ALLOW_FROM     — comma-separated open_id list (default: "*")
 *   FEISHU_REACT_EMOJI    — reaction emoji on receive (default: "THUMBSUP")
 */

import fs from 'node:fs';
import path from 'node:path';
import type { OutboundMessage } from '../types/index.js';
import type { MessageBus } from '../bus/queue.js';
import { BaseChannel, type ChannelConfig } from './base.js';

type LarkModule = typeof import('@larksuiteoapi/node-sdk');
type LarkClient = InstanceType<LarkModule['Client']>;
type LarkReceiveIdType = 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';

export class FeishuChannel extends BaseChannel {
  readonly name = 'feishu';

  private _client: LarkClient | null = null;
  private readonly _appId: string;
  private readonly _appSecret: string;
  private readonly _reactEmoji: string;
  private readonly _processedIds = new Map<string, number>();

  constructor(config: ChannelConfig, bus: MessageBus) {
    super(config, bus);
    this._appId = process.env['FEISHU_APP_ID'] ?? '';
    this._appSecret = process.env['FEISHU_APP_SECRET'] ?? '';
    this._reactEmoji = process.env['FEISHU_REACT_EMOJI'] ?? 'THUMBSUP';
  }

  async start(): Promise<void> {
    if (!this._appId || !this._appSecret) {
      console.error('[feishu] app_id and app_secret not configured');
      return;
    }

    let lark: LarkModule;
    try {
      lark = await import('@larksuiteoapi/node-sdk');
    } catch {
      console.error('[feishu] @larksuiteoapi/node-sdk not installed. Run: npm install @larksuiteoapi/node-sdk');
      return;
    }

    this._running = true;

    this._client = new lark.Client({
      appId: this._appId,
      appSecret: this._appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    // EventDispatcher handles event routing
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        await this._onMessage(data).catch((e) =>
          console.error('[feishu] Message handler error:', e),
        );
      },
    });

    // WSClient handles the WebSocket long connection
    const wsClient = new lark.WSClient({
      appId: this._appId,
      appSecret: this._appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    console.log('[feishu] Starting WebSocket long connection...');
    // start() is long-running — pass the eventDispatcher
    wsClient.start({ eventDispatcher }).catch((e) => {
      if (this._running) console.error('[feishu] WS error:', e);
    });

    // Keep running until stopped
    while (this._running) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    console.log('[feishu] Stopped');
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this._client) {
      console.warn('[feishu] Client not initialized');
      return;
    }

    const receiveIdType: LarkReceiveIdType = msg.chatId.startsWith('oc_') ? 'chat_id' : 'open_id';

    // Send media files
    for (const mediaPath of msg.media ?? []) {
      if (!fs.existsSync(mediaPath)) {
        console.warn('[feishu] Media file not found:', mediaPath);
        continue;
      }
      await this._sendMedia(msg.chatId, receiveIdType, mediaPath).catch(
        (e) => console.error('[feishu] Media send failed:', e),
      );
    }

    // Send text as interactive card for rich formatting
    if (msg.content?.trim()) {
      const card = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: msg.content }],
      };
      await this._sendMessage(
        msg.chatId,
        receiveIdType,
        'interactive',
        JSON.stringify(card),
      ).catch((e) => console.error('[feishu] Send failed:', e));
    }
  }

  private async _sendMessage(
    receiveId: string,
    receiveIdType: LarkReceiveIdType,
    msgType: string,
    content: string,
  ): Promise<void> {
    if (!this._client) return;
    await this._client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: msgType, content },
    });
  }

  private async _sendMedia(
    chatId: string,
    receiveIdType: LarkReceiveIdType,
    filePath: string,
  ): Promise<void> {
    if (!this._client) return;
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
    const isImage = imageExts.has(ext);

    if (isImage) {
      const resp = await this._client.im.v1.image.create({
        data: { image_type: 'message', image: fs.createReadStream(filePath) },
      });
      if (resp?.image_key) {
        await this._sendMessage(
          chatId,
          receiveIdType,
          'image',
          JSON.stringify({ image_key: resp.image_key }),
        );
      }
    } else {
      const fileName = path.basename(filePath);
      const fileType = this._getFeishuFileType(ext) as 'stream' | 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt';
      const resp = await this._client.im.v1.file.create({
        data: { file_type: fileType, file_name: fileName, file: fs.createReadStream(filePath) },
      });
      if (resp?.file_key) {
        await this._sendMessage(
          chatId,
          receiveIdType,
          'file',
          JSON.stringify({ file_key: resp.file_key }),
        );
      }
    }
  }

  private _getFeishuFileType(ext: string): string {
    const map: Record<string, string> = {
      '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc',
      '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt',
      '.mp4': 'mp4', '.opus': 'opus',
    };
    return map[ext] ?? 'stream';
  }

  private async _onMessage(data: Record<string, unknown>): Promise<void> {
    const event = data['event'] as Record<string, unknown>;
    const message = event?.['message'] as Record<string, unknown>;
    const sender = event?.['sender'] as Record<string, unknown>;

    if (!message || !sender) return;

    const messageId = message['message_id'] as string;
    if (!messageId) return;

    // Deduplication
    if (this._processedIds.has(messageId)) return;
    this._processedIds.set(messageId, Date.now());
    if (this._processedIds.size > 1000) {
      const oldest = [...this._processedIds.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this._processedIds.delete(oldest[0]);
    }

    const senderType = (sender['sender_type'] as string) ?? '';
    if (senderType === 'bot') return;

    const senderId =
      ((sender['sender_id'] as Record<string, string> | null)?.['open_id']) ?? 'unknown';
    const chatId = (message['chat_id'] as string) ?? '';
    const chatType = (message['chat_type'] as string) ?? '';
    const msgType = (message['message_type'] as string) ?? 'text';

    // Add reaction (best-effort)
    await this._addReaction(messageId, this._reactEmoji).catch(() => {/* ignore */});

    let rawContent: Record<string, unknown> = {};
    try {
      rawContent = JSON.parse((message['content'] as string) ?? '{}') as Record<string, unknown>;
    } catch { /* ignore */ }

    let contentText = '';
    if (msgType === 'text') {
      contentText = (rawContent['text'] as string) ?? '';
    } else if (msgType === 'post') {
      contentText = this._extractPostText(rawContent);
    } else {
      contentText = `[${msgType}]`;
    }

    if (!contentText) return;

    const replyTo = chatType === 'group' ? chatId : senderId;
    await this._handleMessage({
      senderId,
      chatId: replyTo,
      content: contentText,
      metadata: { messageId, chatType, msgType },
    });
  }

  private _extractPostText(content: Record<string, unknown>): string {
    const texts: string[] = [];
    const locale = (content['zh_cn'] ?? content['en_us'] ?? content) as Record<string, unknown>;
    const blocks = locale?.['content'] as unknown[][] | null;
    if (!blocks) return '';
    for (const row of blocks) {
      if (!Array.isArray(row)) continue;
      for (const el of row) {
        const element = el as Record<string, unknown>;
        if (element['tag'] === 'text' || element['tag'] === 'a') {
          texts.push(String(element['text'] ?? ''));
        }
      }
    }
    return texts.join(' ').trim();
  }

  private async _addReaction(messageId: string, emojiType: string): Promise<void> {
    if (!this._client) return;
    await this._client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
  }
}
