/**
 * Message tool — sends messages back to the user via the message bus.
 */

import { Tool } from './base.js';
import type { JSONSchema, OutboundMessage } from '../types/index.js';

export class MessageTool extends Tool {
  readonly name = 'message';
  readonly description = 'Send a message to the user.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The message content to send' },
      channel: { type: 'string', description: 'Optional: target channel' },
      chat_id: { type: 'string', description: 'Optional: target chat/user ID' },
      media: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: list of file paths to attach',
      },
    },
    required: ['content'],
  };

  private _channel = '';
  private _chatId = '';
  private _messageId?: string;
  private _sentInTurn = false;
  private _sendCallback?: (msg: OutboundMessage) => Promise<void>;

  constructor(sendCallback?: (msg: OutboundMessage) => Promise<void>) {
    super();
    this._sendCallback = sendCallback;
  }

  setContext(channel: string, chatId: string, messageId?: string): void {
    this._channel = channel;
    this._chatId = chatId;
    this._messageId = messageId;
  }

  setSendCallback(cb: (msg: OutboundMessage) => Promise<void>): void {
    this._sendCallback = cb;
  }

  startTurn(): void {
    this._sentInTurn = false;
  }

  get sentInTurn(): boolean {
    return this._sentInTurn;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const content = args['content'] as string;
    const channel = (args['channel'] as string | undefined) ?? this._channel;
    const chatId = (args['chat_id'] as string | undefined) ?? this._chatId;
    const media = args['media'] as string[] | undefined;

    if (!channel || !chatId) return 'Error: No target channel/chat specified';
    if (!this._sendCallback) return 'Error: Message sending not configured';

    const msg: OutboundMessage = {
      channel,
      chatId,
      content,
      media: media ?? [],
      metadata: { messageId: this._messageId },
    };

    try {
      await this._sendCallback(msg);
      this._sentInTurn = true;
      return `Message sent to ${channel}:${chatId}${media?.length ? ` with ${media.length} attachments` : ''}`;
    } catch (err) {
      return `Error sending message: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
