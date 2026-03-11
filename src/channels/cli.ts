/**
 * CliChannel — interactive terminal chat, implements BaseChannel.
 *
 * Features:
 *   - readline-based input
 *   - Progress/tool-hint display via chalk
 *   - Graceful shutdown on SIGINT/SIGTERM
 */

import readline from 'node:readline';
import chalk from 'chalk';
import type { OutboundMessage } from '../types/index.js';
import type { MessageBus } from '../bus/queue.js';
import { BaseChannel } from './base.js';

export class CliChannel extends BaseChannel {
  readonly name = 'cli';

  private _rl: readline.Interface | null = null;

  constructor(bus: MessageBus) {
    // CLI always allows all users (local terminal)
    super({ allowFrom: ['*'] }, bus);
  }

  async start(): Promise<void> {
    this._running = true;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    this._rl = rl;

    console.log(chalk.bold.green('\n🤖 minibot — type your message, /help for commands, Ctrl+C to quit\n'));

    const PROMPT = chalk.cyan('You: ');
    rl.setPrompt(PROMPT);
    rl.prompt();

    rl.on('line', async (line: string) => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }
      await this._handleMessage({
        senderId: 'user',
        chatId: 'direct',
        content: input,
      });
      // Don't re-prompt here; send() does it after the response arrives
    });

    const shutdown = (): void => {
      console.log(chalk.yellow('\n\nGoodbye! 👋'));
      this._running = false;
      rl.close();
      process.exit(0);
    };

    rl.on('close', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Block until the readline interface closes
    await new Promise<void>((resolve) => {
      rl.on('close', resolve);
    });
  }

  async stop(): Promise<void> {
    this._running = false;
    this._rl?.close();
    this._rl = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const BOT_PREFIX = chalk.green('minbot: ');

    if (msg.metadata?.['_progress']) {
      if (msg.metadata['_toolHint']) {
        process.stdout.write(chalk.dim(`  ⚙ ${msg.content}\n`));
      } else if (msg.content) {
        process.stdout.write(chalk.dim(`  ${msg.content}\n`));
      }
      return;
    }

    if (msg.content) {
      console.log(`\n${BOT_PREFIX}${msg.content}\n`);
    }

    // Re-show prompt after response
    this._rl?.prompt();
  }
}
