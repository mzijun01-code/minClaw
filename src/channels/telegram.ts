/**
 * TelegramChannel — Telegram bot using long polling via telegraf.
 *
 * Config env vars:
 *   TELEGRAM_TOKEN       — bot token from @BotFather (required)
 *   TELEGRAM_ALLOW_FROM  — comma-separated user IDs / usernames (default: "*")
 *   TELEGRAM_PROXY       — optional HTTP proxy URL
 */

import type { OutboundMessage } from '../types/index.js';
import type { MessageBus } from '../bus/queue.js';
import { BaseChannel, type ChannelConfig } from './base.js';

// Markdown → Telegram HTML conversion
function markdownToTelegramHtml(text: string): string {
  if (!text) return '';

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Strip headers
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  // 4. Strip blockquotes
  text = text.replace(/^>\s*(.*)$/gm, '$1');

  // 5. Escape HTML special characters
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 6. Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 7. Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
  text = text.replace(/__(.+?)__/gs, '<b>$1</b>');

  // 8. Italic _text_
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, '<i>$1</i>');

  // 9. Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/gs, '<s>$1</s>');

  // 10. Bullet lists
  text = text.replace(/^[-*]\s+/gm, '• ');

  // 11. Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    const escaped = inlineCodes[i]!
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    text = text.replace(`\x00IC${i}\x00`, `<code>${escaped}</code>`);
  }

  // 12. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    const escaped = codeBlocks[i]!
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    text = text.replace(`\x00CB${i}\x00`, `<pre><code>${escaped}</code></pre>`);
  }

  return text;
}

function splitMessage(content: string, maxLen = 4000): string[] {
  if (content.length <= maxLen) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > maxLen) {
    let cut = remaining.slice(0, maxLen);
    let pos = cut.lastIndexOf('\n');
    if (pos === -1) pos = cut.lastIndexOf(' ');
    if (pos === -1) pos = maxLen;
    chunks.push(remaining.slice(0, pos));
    remaining = remaining.slice(pos).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class TelegramChannel extends BaseChannel {
  readonly name = 'telegram';

  private _bot: import('telegraf').Telegraf | null = null;
  private _typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: ChannelConfig, bus: MessageBus) {
    super(config, bus);
  }

  async start(): Promise<void> {
    const token = process.env['TELEGRAM_TOKEN'];
    if (!token) {
      console.error('[telegram] Bot token not configured');
      return;
    }

    const { Telegraf } = await import('telegraf');
    this._bot = new Telegraf(token);
    this._running = true;

    // ── Command handlers ───────────────────────────────────────────────────────
    this._bot.command('start', async (ctx) => {
      const name = ctx.from?.first_name ?? 'there';
      await ctx.reply(
        `👋 Hi ${name}! I'm minbot.\n\nSend me a message and I'll respond!\n/help for commands.`,
      );
    });

    this._bot.command('help', async (ctx) => {
      await ctx.reply(
        '🤖 minbot commands:\n/new — Start a new conversation\n/help — Show this message',
      );
    });

    this._bot.command('new', async (ctx) => {
      await this._forwardCommand(ctx);
    });

    // ── Message handler ────────────────────────────────────────────────────────
    this._bot.on('message', async (ctx) => {
      const msg = ctx.message;
      const user = ctx.from;
      if (!user) return;

      const chatId = String(ctx.chat.id);
      const senderId = user.username ? `${user.id}|${user.username}` : String(user.id);

      const contentParts: string[] = [];
      const mediaPaths: string[] = [];

      if ('text' in msg && msg.text) contentParts.push(msg.text);
      if ('caption' in msg && msg.caption) contentParts.push(msg.caption);

      // Media handling
      if ('photo' in msg && msg.photo?.length) {
        const photo = msg.photo[msg.photo.length - 1]!;
        try {
          const path = await this._downloadFile(photo.file_id, '.jpg');
          if (path) {
            mediaPaths.push(path);
            contentParts.push(`[image: ${path}]`);
          }
        } catch {
          contentParts.push('[image: download failed]');
        }
      } else if ('voice' in msg && msg.voice) {
        try {
          const path = await this._downloadFile(msg.voice.file_id, '.ogg');
          if (path) {
            mediaPaths.push(path);
            contentParts.push(`[voice: ${path}]`);
          }
        } catch {
          contentParts.push('[voice: download failed]');
        }
      } else if ('document' in msg && msg.document) {
        const ext = msg.document.file_name?.includes('.') ?
          `.${msg.document.file_name.split('.').pop()}` : '';
        try {
          const path = await this._downloadFile(msg.document.file_id, ext);
          if (path) {
            mediaPaths.push(path);
            contentParts.push(`[file: ${path}]`);
          }
        } catch {
          contentParts.push('[file: download failed]');
        }
      }

      const content = contentParts.join('\n') || '[empty message]';

      this._startTyping(chatId);

      await this._handleMessage({
        senderId,
        chatId,
        content,
        media: mediaPaths,
        metadata: {
          messageId: ('message_id' in msg) ? msg.message_id : undefined,
          userId: user.id,
          username: user.username,
          firstName: user.first_name,
          isGroup: ctx.chat.type !== 'private',
        },
      });
    });

    // ── Start polling ──────────────────────────────────────────────────────────
    console.log('[telegram] Starting long polling...');
    await this._bot.launch({ dropPendingUpdates: true });

    const botInfo = this._bot.botInfo;
    if (botInfo) {
      console.log(`[telegram] Bot @${botInfo.username} connected`);
    }

    // Keep running until stopped
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  }

  async stop(): Promise<void> {
    this._running = false;
    for (const [chatId] of this._typingTimers) {
      this._stopTyping(chatId);
    }
    this._bot?.stop();
    this._bot = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this._bot) {
      console.warn('[telegram] Bot not running');
      return;
    }

    this._stopTyping(msg.chatId);

    const chatId = parseInt(msg.chatId, 10);
    if (isNaN(chatId)) {
      console.error('[telegram] Invalid chat_id:', msg.chatId);
      return;
    }

    const replyToMessageId =
      typeof msg.metadata?.['messageId'] === 'number' ? msg.metadata['messageId'] : undefined;

    // Send media files
    for (const mediaPath of msg.media ?? []) {
      try {
        const { createReadStream } = await import('node:fs');
        await this._bot.telegram.sendDocument(chatId, { source: createReadStream(mediaPath) });
      } catch (e) {
        console.error('[telegram] Failed to send media:', e);
      }
    }

    // Send text content
    if (msg.content && msg.content !== '[empty message]') {
      for (const chunk of splitMessage(msg.content)) {
        const html = markdownToTelegramHtml(chunk);
        try {
          await this._bot.telegram.sendMessage(chatId, html, {
            parse_mode: 'HTML',
            ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
          });
        } catch {
          // Fallback to plain text if HTML parsing fails
          try {
            await this._bot.telegram.sendMessage(chatId, chunk, {
              ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
            });
          } catch (e2) {
            console.error('[telegram] Error sending message:', e2);
          }
        }
      }
    }
  }

  private async _forwardCommand(ctx: import('telegraf').Context): Promise<void> {
    if (!ctx.from || !ctx.chat) return;
    const senderId = ctx.from.username
      ? `${ctx.from.id}|${ctx.from.username}`
      : String(ctx.from.id);
    const text = ('text' in ctx.message! ? ctx.message.text : '') ?? '';
    await this._handleMessage({
      senderId,
      chatId: String(ctx.chat.id),
      content: text,
    });
  }

  private _startTyping(chatId: string): void {
    this._stopTyping(chatId);
    const send = () => {
      const chatIdNum = parseInt(chatId, 10);
      if (!isNaN(chatIdNum) && this._bot) {
        this._bot.telegram.sendChatAction(chatIdNum, 'typing').catch(() => {/* ignore */});
      }
    };
    send();
    this._typingTimers.set(chatId, setInterval(send, 4000));
  }

  private _stopTyping(chatId: string): void {
    const timer = this._typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      this._typingTimers.delete(chatId);
    }
  }

  private async _downloadFile(fileId: string, ext: string): Promise<string | null> {
    if (!this._bot) return null;
    try {
      const fileLink = await this._bot.telegram.getFileLink(fileId);
      const url = fileLink.href;

      const { default: https } = await import('node:https');
      const { default: fs } = await import('node:fs');
      const { default: path } = await import('node:path');
      const { default: os } = await import('node:os');

      const mediaDir = path.join(os.homedir(), '.minbot', 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const filePath = path.join(mediaDir, `${fileId.slice(0, 16)}${ext}`);

      await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        https.get(url, (res) => {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (e) => { fs.unlink(filePath, () => {}); reject(e); });
      });

      return filePath;
    } catch (e) {
      console.error('[telegram] Download failed:', e);
      return null;
    }
  }
}
