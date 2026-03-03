/**
 * ChannelManager — manages chat channels and routes outbound messages.
 *
 * Responsibilities:
 * - Initialize enabled channels based on environment variables
 * - Start/stop all channels
 * - Dispatch outbound messages from the bus to the correct channel
 */

import type { MessageBus } from '../bus/queue.js';
import type { OutboundMessage } from '../types/index.js';
import type { BaseChannel } from './base.js';

export class ChannelManager {
  private readonly bus: MessageBus;
  private readonly channels = new Map<string, BaseChannel>();
  private _running = false;

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  /**
   * Parse ALLOW_FROM env var: comma-separated list of IDs.
   * If unset or empty → ["*"] (allow all — safe default for local channels).
   */
  static parseAllowFrom(raw: string | undefined): string[] {
    if (!raw || raw.trim() === '') return ['*'];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  private _register(channel: BaseChannel): void {
    this.channels.set(channel.name, channel);
  }

  private _validateAllowFrom(): void {
    for (const [name, ch] of this.channels) {
      const allowFrom: string[] = (ch as unknown as { config: { allowFrom: string[] } }).config?.allowFrom ?? [];
      if (allowFrom.length === 0) {
        throw new Error(
          `Channel "${name}" has empty allowFrom (denies all). ` +
            `Set ["*"] to allow everyone or add specific IDs via ${name.toUpperCase()}_ALLOW_FROM.`,
        );
      }
    }
  }

  /** Initialize all channels based on environment variables. Must be called before startAll(). */
  async init(): Promise<void> {
    // ── CLI channel (always enabled) ──────────────────────────────────────────
    const { CliChannel } = await import('./cli.js');
    this._register(new CliChannel(this.bus));

    // ── Telegram ──────────────────────────────────────────────────────────────
    if (process.env['TELEGRAM_TOKEN']) {
      try {
        const { TelegramChannel } = await import('./telegram.js');
        const allowFrom = ChannelManager.parseAllowFrom(process.env['TELEGRAM_ALLOW_FROM']);
        this._register(new TelegramChannel({ allowFrom }, this.bus));
        console.log('[channels] Telegram channel enabled');
      } catch (e) {
        console.warn('[channels] Telegram channel unavailable:', (e as Error).message);
      }
    }

    // ── Discord ───────────────────────────────────────────────────────────────
    if (process.env['DISCORD_TOKEN']) {
      try {
        const { DiscordChannel } = await import('./discord.js');
        const allowFrom = ChannelManager.parseAllowFrom(process.env['DISCORD_ALLOW_FROM']);
        this._register(new DiscordChannel({ allowFrom }, this.bus));
        console.log('[channels] Discord channel enabled');
      } catch (e) {
        console.warn('[channels] Discord channel unavailable:', (e as Error).message);
      }
    }

    // ── Feishu / Lark ─────────────────────────────────────────────────────────
    if (process.env['FEISHU_APP_ID'] && process.env['FEISHU_APP_SECRET']) {
      try {
        const { FeishuChannel } = await import('./feishu.js');
        const allowFrom = ChannelManager.parseAllowFrom(process.env['FEISHU_ALLOW_FROM']);
        this._register(new FeishuChannel({ allowFrom }, this.bus));
        console.log('[channels] Feishu channel enabled');
      } catch (e) {
        console.warn('[channels] Feishu channel unavailable:', (e as Error).message);
      }
    }

    // ── DingTalk ──────────────────────────────────────────────────────────────
    if (process.env['DINGTALK_CLIENT_ID'] && process.env['DINGTALK_CLIENT_SECRET']) {
      try {
        const { DingTalkChannel } = await import('./dingtalk.js');
        const allowFrom = ChannelManager.parseAllowFrom(process.env['DINGTALK_ALLOW_FROM']);
        this._register(new DingTalkChannel({ allowFrom }, this.bus));
        console.log('[channels] DingTalk channel enabled');
      } catch (e) {
        console.warn('[channels] DingTalk channel unavailable:', (e as Error).message);
      }
    }

    // ── Slack ─────────────────────────────────────────────────────────────────
    if (process.env['SLACK_BOT_TOKEN'] && process.env['SLACK_APP_TOKEN']) {
      try {
        const { SlackChannel } = await import('./slack.js');
        const allowFrom = ChannelManager.parseAllowFrom(process.env['SLACK_ALLOW_FROM']);
        this._register(new SlackChannel({ allowFrom }, this.bus));
        console.log('[channels] Slack channel enabled');
      } catch (e) {
        console.warn('[channels] Slack channel unavailable:', (e as Error).message);
      }
    }

    this._validateAllowFrom();
  }

  async startAll(): Promise<void> {
    await this.init();

    if (this.channels.size === 0) {
      console.warn('[channels] No channels enabled');
      return;
    }

    this._running = true;

    // Start outbound dispatcher in the background
    this._dispatchOutbound().catch((e) => {
      if (this._running) console.error('[channels] Dispatch loop error:', e);
    });

    // Start all channels concurrently
    const tasks = [...this.channels.entries()].map(async ([name, channel]) => {
      console.log(`[channels] Starting ${name}...`);
      try {
        await channel.start();
      } catch (e) {
        console.error(`[channels] Failed to start ${name}:`, e);
      }
    });

    await Promise.all(tasks);
  }

  async stopAll(): Promise<void> {
    console.log('[channels] Stopping all channels...');
    this._running = false;

    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
        console.log(`[channels] Stopped ${name}`);
      } catch (e) {
        console.error(`[channels] Error stopping ${name}:`, e);
      }
    }
  }

  private async _dispatchOutbound(): Promise<void> {
    console.log('[channels] Outbound dispatcher started');

    while (this._running) {
      let msg: OutboundMessage | null = null;

      try {
        // Await with a 1-second timeout so we can check _running periodically
        msg = await Promise.race([
          this.bus.consumeOutbound(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ]);
      } catch {
        continue;
      }

      if (!msg) continue;

      // Filter progress messages based on config
      if (msg.metadata?.['_progress']) {
        const sendToolHints = process.env['SEND_TOOL_HINTS'] !== 'false';
        const sendProgress = process.env['SEND_PROGRESS'] !== 'false';
        if (msg.metadata['_toolHint'] && !sendToolHints) continue;
        if (!msg.metadata['_toolHint'] && !sendProgress) continue;
      }

      const channel = this.channels.get(msg.channel);
      if (channel) {
        try {
          await channel.send(msg);
        } catch (e) {
          console.error(`[channels] Error sending to ${msg.channel}:`, e);
        }
      } else {
        console.warn(`[channels] Unknown channel: ${msg.channel}`);
      }
    }
  }

  getChannel(name: string): BaseChannel | undefined {
    return this.channels.get(name);
  }

  getStatus(): Record<string, { running: boolean }> {
    const status: Record<string, { running: boolean }> = {};
    for (const [name, channel] of this.channels) {
      status[name] = { running: channel.isRunning };
    }
    return status;
  }

  get enabledChannels(): string[] {
    return [...this.channels.keys()];
  }
}
