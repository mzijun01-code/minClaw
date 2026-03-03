/**
 * BaseChannel — abstract base class for chat channel implementations.
 *
 * Each channel (Telegram, Discord, etc.) extends this class and connects
 * to the MessageBus to send/receive InboundMessage / OutboundMessage.
 */

import type { InboundMessage, OutboundMessage } from '../types/index.js';
import type { MessageBus } from '../bus/queue.js';

export interface ChannelConfig {
  /** List of allowed sender IDs. Use ["*"] to allow all, [] to deny all. */
  allowFrom: string[];
}

export abstract class BaseChannel {
  abstract readonly name: string;

  protected readonly bus: MessageBus;
  protected readonly config: ChannelConfig;
  protected _running = false;

  constructor(config: ChannelConfig, bus: MessageBus) {
    this.config = config;
    this.bus = bus;
  }

  /** Start the channel and begin listening for messages (long-running). */
  abstract start(): Promise<void>;

  /** Stop the channel and clean up resources. */
  abstract stop(): Promise<void>;

  /** Send an outbound message through this channel. */
  abstract send(msg: OutboundMessage): Promise<void>;

  get isRunning(): boolean {
    return this._running;
  }

  /**
   * Check if a sender is permitted.
   * - Empty list → deny all
   * - "*" in list → allow all
   * - Otherwise check exact match or pipe-separated aliases
   */
  isAllowed(senderId: string): boolean {
    const { allowFrom } = this.config;
    if (!allowFrom || allowFrom.length === 0) {
      console.warn(`[${this.name}] allowFrom is empty — all access denied`);
      return false;
    }
    if (allowFrom.includes('*')) return true;
    const parts = senderId.split('|').filter(Boolean);
    return allowFrom.includes(senderId) || parts.some((p) => allowFrom.includes(p));
  }

  /**
   * Handle an incoming message from the chat platform.
   * Checks permissions then publishes to the message bus.
   */
  protected async _handleMessage(opts: {
    senderId: string;
    chatId: string;
    content: string;
    media?: string[];
    metadata?: Record<string, unknown>;
    sessionKeyOverride?: string;
  }): Promise<void> {
    const { senderId, chatId, content, media, metadata, sessionKeyOverride } = opts;

    if (!this.isAllowed(senderId)) {
      console.warn(
        `[${this.name}] Access denied for sender ${senderId}. ` +
          `Add them to allowFrom to grant access.`,
      );
      return;
    }

    const msg: InboundMessage = {
      channel: this.name,
      senderId,
      chatId,
      content,
      timestamp: new Date(),
      media: media ?? [],
      metadata: metadata ?? {},
      sessionKeyOverride,
    };

    await this.bus.publishInbound(msg);
  }
}
