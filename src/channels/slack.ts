/**
 * SlackChannel — Slack via Socket Mode.
 *
 * Uses @slack/socket-mode for receiving events and @slack/web-api for sending.
 *
 * Config env vars:
 *   SLACK_BOT_TOKEN    — Bot OAuth token (xoxb-...) (required)
 *   SLACK_APP_TOKEN    — App-level token (xapp-...) for Socket Mode (required)
 *   SLACK_ALLOW_FROM   — comma-separated user IDs (default: "*")
 *   SLACK_GROUP_POLICY — "open" | "mention" | "allowlist" (default: "mention")
 *   SLACK_REACT_EMOJI  — reaction emoji on receive (default: "eyes")
 */

import type { OutboundMessage } from '../types/index.js';
import type { MessageBus } from '../bus/queue.js';
import { BaseChannel, type ChannelConfig } from './base.js';

export class SlackChannel extends BaseChannel {
  readonly name = 'slack';

  private readonly _botToken: string;
  private readonly _appToken: string;
  private readonly _groupPolicy: string;
  private readonly _reactEmoji: string;
  private _botUserId: string | null = null;
  private _webClient: import('@slack/web-api').WebClient | null = null;
  private _socketClient: import('@slack/socket-mode').SocketModeClient | null = null;

  constructor(config: ChannelConfig, bus: MessageBus) {
    super(config, bus);
    this._botToken = process.env['SLACK_BOT_TOKEN'] ?? '';
    this._appToken = process.env['SLACK_APP_TOKEN'] ?? '';
    this._groupPolicy = process.env['SLACK_GROUP_POLICY'] ?? 'mention';
    this._reactEmoji = process.env['SLACK_REACT_EMOJI'] ?? 'eyes';
  }

  async start(): Promise<void> {
    if (!this._botToken || !this._appToken) {
      console.error('[slack] bot_token and app_token not configured');
      return;
    }

    let WebClient: typeof import('@slack/web-api').WebClient;
    let SocketModeClient: typeof import('@slack/socket-mode').SocketModeClient;

    try {
      const [webApi, socketMode] = await Promise.all([
        import('@slack/web-api'),
        import('@slack/socket-mode'),
      ]);
      WebClient = webApi.WebClient;
      SocketModeClient = socketMode.SocketModeClient;
    } catch {
      console.error('[slack] @slack/web-api or @slack/socket-mode not installed.');
      return;
    }

    this._running = true;

    // Web client for sending messages (uses bot token)
    this._webClient = new WebClient(this._botToken);

    // Socket Mode client for receiving events (uses app token)
    this._socketClient = new SocketModeClient({ appToken: this._appToken });

    // Resolve bot user ID for mention filtering
    try {
      const auth = await this._webClient.auth.test();
      this._botUserId = (auth['user_id'] as string | undefined) ?? null;
      console.log(`[slack] Bot connected as ${this._botUserId}`);
    } catch (e) {
      console.warn('[slack] auth.test failed:', e);
    }

    // Listen for all events via Socket Mode
    this._socketClient.on(
      'slack_event',
      async ({ ack, event }: { ack: () => Promise<void>; event: Record<string, unknown> }) => {
        await ack();
        await this._onEvent(event).catch(
          (e) => console.error('[slack] Event handler error:', e),
        );
      },
    );

    console.log('[slack] Starting Socket Mode...');
    await this._socketClient.start();

    while (this._running) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    try {
      await this._socketClient?.disconnect();
    } catch { /* ignore */ }
    this._socketClient = null;
    this._webClient = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this._webClient) {
      console.warn('[slack] Client not running');
      return;
    }

    const slackMeta = (msg.metadata?.['slack'] as Record<string, unknown>) ?? {};
    const threadTs = slackMeta['thread_ts'] as string | undefined;
    const channelType = slackMeta['channel_type'] as string | undefined;
    const useThread = threadTs && channelType !== 'im' ? threadTs : undefined;

    if (msg.content) {
      try {
        await this._webClient.chat.postMessage({
          channel: msg.chatId,
          text: msg.content,
          ...(useThread ? { thread_ts: useThread } : {}),
        });
      } catch (e) {
        console.error('[slack] Error sending message:', e);
      }
    }

    for (const mediaPath of msg.media ?? []) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uploadArgs: any = { channel_id: msg.chatId, file: mediaPath };
        if (useThread) uploadArgs.thread_ts = useThread;
        await this._webClient.files.uploadV2(uploadArgs);
      } catch (e) {
        console.error('[slack] Failed to upload file:', e);
      }
    }
  }

  private async _onEvent(event: Record<string, unknown>): Promise<void> {
    const eventType = event['type'] as string;
    if (eventType !== 'message' && eventType !== 'app_mention') return;

    const senderId = event['user'] as string;
    const chatId = event['channel'] as string;
    const channelType = (event['channel_type'] as string) ?? '';

    // Ignore bot/system messages
    if (event['subtype']) return;
    if (this._botUserId && senderId === this._botUserId) return;

    let text = (event['text'] as string) ?? '';

    // Avoid double-processing: app_mention + message for same msg in channels
    if (
      eventType === 'message' &&
      this._botUserId &&
      text.includes(`<@${this._botUserId}>`)
    ) {
      return;
    }

    if (!senderId || !chatId) return;

    // Permission check
    if (!this._checkAllowed(senderId, chatId, channelType)) return;

    // In channels, only respond if policy allows
    if (channelType !== 'im' && !this._shouldRespond(eventType, text, chatId)) return;

    // Strip bot mention from text
    if (this._botUserId) {
      text = text.replace(new RegExp(`<@${this._botUserId}>\\s*`, 'g'), '').trim();
    }

    // Add reaction (best-effort)
    const ts = event['ts'] as string | undefined;
    if (ts) {
      this._webClient?.reactions
        .add({ channel: chatId, name: this._reactEmoji, timestamp: ts })
        .catch(() => {/* ignore */});
    }

    const threadTs = (event['thread_ts'] as string | undefined) ?? ts;
    const sessionKey =
      threadTs && channelType !== 'im' ? `slack:${chatId}:${threadTs}` : undefined;

    await this._handleMessage({
      senderId,
      chatId,
      content: text,
      metadata: { slack: { event, thread_ts: threadTs, channel_type: channelType } },
      sessionKeyOverride: sessionKey,
    });
  }

  private _checkAllowed(senderId: string, chatId: string, channelType: string): boolean {
    if (channelType === 'im') {
      return this.isAllowed(senderId);
    }
    if (this._groupPolicy === 'allowlist') {
      return this.config.allowFrom.includes(chatId);
    }
    return true;
  }

  private _shouldRespond(eventType: string, text: string, _chatId: string): boolean {
    if (this._groupPolicy === 'open') return true;
    if (this._groupPolicy === 'mention') {
      if (eventType === 'app_mention') return true;
      return this._botUserId !== null && text.includes(`<@${this._botUserId}>`);
    }
    return false;
  }
}
