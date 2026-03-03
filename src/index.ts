#!/usr/bin/env node
/**
 * minbot — main entry point
 *
 * Wires together all components and starts the CLI.
 *
 * Configuration is read from environment variables (loaded from .env):
 *   OPENAI_API_KEY  — required
 *   OPENAI_API_BASE — optional (default: OpenAI)
 *   MODEL           — required
 *   WORKSPACE       — optional (default: ~/.minbot)
 *   MAX_ITERATIONS  — optional
 *   MEMORY_WINDOW   — optional
 *   MAX_TOKENS      — optional
 *   TEMPERATURE     — optional
 *   BRAVE_API_KEY   — optional (for web_search)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import 'dotenv/config';

import { MessageBus } from './bus/queue.js';
import { LangChainProvider } from './providers/langchain.js';
import { AgentLoop } from './agent/loop.js';
import { CronService } from './cron/service.js';
import { ChannelManager } from './channels/manager.js';

function getEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    console.error(`❌  Missing required environment variable: ${key}`);
    console.error(`    Copy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
  return val;
}

async function main(): Promise<void> {
  // ─── Config ────────────────────────────────────────────────────────────────
  const apiKey = getEnv('OPENAI_API_KEY');
  const apiBase = process.env['OPENAI_API_BASE'];
  const model = getEnv('MODEL', 'gpt-4o');
  const rawWorkspace = process.env['WORKSPACE'] ?? '~/.minbot';
  const workspace = rawWorkspace.startsWith('~')
    ? path.join(os.homedir(), rawWorkspace.slice(1))
    : path.resolve(rawWorkspace);

  const maxIterations = parseInt(process.env['MAX_ITERATIONS'] ?? '40', 10);
  const memoryWindow = parseInt(process.env['MEMORY_WINDOW'] ?? '100', 10);
  const maxTokens = parseInt(process.env['MAX_TOKENS'] ?? '4096', 10);
  const temperature = parseFloat(process.env['TEMPERATURE'] ?? '0.1');
  const braveApiKey = process.env['BRAVE_API_KEY'];

  // ─── Builtin skills directory ───────────────────────────────────────────────
  // Resolves to minbot/skills/ regardless of whether running from src/ or dist/
  const builtinSkillsDir = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../skills',
  );

  // ─── Workspace ──────────────────────────────────────────────────────────────
  fs.mkdirSync(workspace, { recursive: true });
  console.log(`📁 Workspace: ${workspace}`);
  console.log(`🤖 Model: ${model}`);

  // ─── Core components ────────────────────────────────────────────────────────
  const provider = new LangChainProvider({
    apiKey,
    apiBase,
    model,
    temperature,
    maxTokens,
  });

  const bus = new MessageBus();

  const cronService = new CronService(workspace);

  const loop = new AgentLoop(bus, {
    workspace,
    provider,
    model,
    maxIterations,
    memoryWindow,
    maxTokens,
    temperature,
    braveApiKey,
    cronService,
    restrictToWorkspace: false,
    builtinSkillsDir,
  });

  // Hook cron job firing → inject as system message
  cronService.onFire((job) => {
    const msg = {
      channel: 'system',
      senderId: 'cron',
      chatId: `${job.channel}:${job.to}`,
      content: `[Cron job '${job.name}'] ${job.message}`,
      timestamp: new Date(),
    };
    bus.publishInbound(msg).catch(console.error);
  });

  cronService.start();

  // ─── Start channels ──────────────────────────────────────────────────────────
  const channelManager = new ChannelManager(bus);
  loop.run().catch((err: unknown) => {
    console.error('Fatal agent error:', err);
    process.exit(1);
  });

  await channelManager.startAll();
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
