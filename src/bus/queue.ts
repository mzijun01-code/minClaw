/**
 * Async message bus — decouples chat channels from the agent core.
 *
 * Channels push InboundMessages; the agent consumes them and pushes
 * OutboundMessages back; channels/CLI consume those.
 *
 * Uses a simple Promise-chain queue to mimic Python's asyncio.Queue.
 */

import type { InboundMessage, OutboundMessage } from '../types/index.js';

class AsyncQueue<T> {
  private readonly _items: T[] = [];
  private readonly _waiters: Array<(value: T) => void> = [];

  enqueue(item: T): void {
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this._items.push(item);
    }
  }

  dequeue(): Promise<T> {
    const item = this._items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    return new Promise<T>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  get size(): number {
    return this._items.length;
  }
}

export class MessageBus {
  private readonly _inbound = new AsyncQueue<InboundMessage>();
  private readonly _outbound = new AsyncQueue<OutboundMessage>();

  async publishInbound(msg: InboundMessage): Promise<void> {
    this._inbound.enqueue(msg);
  }

  async consumeInbound(): Promise<InboundMessage> {
    return this._inbound.dequeue();
  }

  async publishOutbound(msg: OutboundMessage): Promise<void> {
    this._outbound.enqueue(msg);
  }

  async consumeOutbound(): Promise<OutboundMessage> {
    return this._outbound.dequeue();
  }

  get inboundSize(): number {
    return this._inbound.size;
  }

  get outboundSize(): number {
    return this._outbound.size;
  }
}
