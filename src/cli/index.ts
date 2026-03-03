/**
 * CLI interface — interactive terminal chat with minbot.
 *
 * Features:
 *   - readline-based input
 *   - Streaming-style progress display (tool calls, intermediate messages)
 *   - Colored output via chalk
 *   - Graceful shutdown on SIGINT/SIGTERM
 */

import readline from 'node:readline';
import chalk from 'chalk';
import type { MessageBus } from '../bus/queue.js';
import type { AgentLoop } from '../agent/loop.js';
import type { InboundMessage, OutboundMessage } from '../types/index.js';

const PROMPT = chalk.cyan('You: ');
const BOT_PREFIX = chalk.green('minbot: ');

export async function runCli(bus: MessageBus, loop: AgentLoop): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log(chalk.bold.green('\n🤖 minbot — type your message, /help for commands, Ctrl+C to quit\n'));

  // Start the agent loop in background
  const loopPromise = loop.run().catch((err: unknown) => {
    console.error(chalk.red('[Agent] Fatal error:'), err);
  });

  // Output consumer: prints responses as they arrive
  const outputLoop = async (): Promise<void> => {
    while (true) {
      const msg: OutboundMessage = await bus.consumeOutbound();

      if (msg.metadata?.['_progress']) {
        if (msg.metadata['_toolHint']) {
          process.stdout.write(chalk.dim(`  ⚙ ${msg.content}\n`));
        } else if (msg.content) {
          process.stdout.write(chalk.dim(`  ${msg.content}\n`));
        }
        continue;
      }

      if (msg.content) {
        console.log(`\n${BOT_PREFIX}${msg.content}\n`);
      }

      // Re-show prompt after response
      rl.prompt();
    }
  };

  outputLoop().catch(() => {/* bus closed on exit */});

  rl.setPrompt(PROMPT);
  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const msg: InboundMessage = {
      channel: 'cli',
      senderId: 'user',
      chatId: 'direct',
      content: input,
      timestamp: new Date(),
    };

    await bus.publishInbound(msg);
    // Don't re-prompt here; the output loop does it after the response
  });

  // Handle graceful shutdown
  const shutdown = (): void => {
    console.log(chalk.yellow('\n\nGoodbye! 👋'));
    loop.stop();
    rl.close();
    process.exit(0);
  };

  rl.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await loopPromise;
}
