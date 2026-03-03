/**
 * ContextBuilder — 上下文构建器，负责组装系统提示词和消息列表供 LLM 使用
 *
 * 系统提示词结构：
 *   1. 核心身份 + 工作区信息 + 工具使用指南
 *   2. 引导文件 (AGENTS.md, SOUL.md, USER.md, TOOLS.md, IDENTITY.md)
 *   3. 长期记忆 (MEMORY.md)
 *   4. 常驻技能 (always=true 的技能会自动加载)
 *   5. 技能目录摘要 (支持渐进式加载)
 *
 * 每条用户消息都会附加运行时上下文：
 *   当前时间、频道、会话 ID
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from './memory.js';
import { SkillsLoader } from './skills.js';
import type { SessionMessage, ToolCallDict } from '../types/index.js';

const BOOTSTRAP_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md'];

export class ContextBuilder {
  private readonly _workspace: string;      // 工作区根路径
  private readonly _memory: MemoryStore;    // 记忆存储实例
  private readonly _skills: SkillsLoader;   // 技能加载器实例

  constructor(workspace: string, builtinSkillsDir?: string) {
    this._workspace = workspace;
    this._memory = new MemoryStore(workspace);
    this._skills = new SkillsLoader(workspace, builtinSkillsDir);
  }

  get memory(): MemoryStore {
    return this._memory;
  }

  /**
   * 构建系统提示词
   * 按顺序组装：身份信息 → 引导文件 → 长期记忆 → 常驻技能 → 技能摘要
   */
  buildSystemPrompt(): string {
    const parts: string[] = [];

    // 1. 核心身份和运行环境信息
    parts.push(this._identity());

    // 2. 加载引导配置文件
    const bootstrap = this._loadBootstrapFiles();
    if (bootstrap) parts.push(bootstrap);

    // 3. 注入长期记忆上下文
    const memCtx = this._memory.getMemoryContext();
    if (memCtx) parts.push(`# Memory\n\n${memCtx}`);

    // 4. 加载 always=true 的常驻技能
    const alwaysSkills = this._skills.getAlwaysSkills();
    if (alwaysSkills.length > 0) {
      const alwaysContent = this._skills.loadSkillsForContext(alwaysSkills);
      if (alwaysContent) parts.push(`# Active Skills\n\n${alwaysContent}`);
    }

    // 5. 技能目录摘要，供 Agent 按需加载
    const skillsSummary = this._skills.buildSkillsSummary();
    if (skillsSummary) {
      parts.push(
        `# Skills\n\nThe following skills extend your capabilities. ` +
          `To use a skill, read its SKILL.md file using the read_file tool.\n\n` +
          skillsSummary,
      );
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * 构建完整的消息数组，供 LLM 调用
   * 结构：[系统提示词] + [历史消息...] + [当前用户消息(含运行时上下文)]
   */
  buildMessages(params: {
    history: SessionMessage[];
    currentMessage: string;
    channel?: string;
    chatId?: string;
    media?: string[];
  }): SessionMessage[] {
    const messages: SessionMessage[] = [];

    // 系统提示词（包含身份、记忆、技能等）
    messages.push({ role: 'system', content: this.buildSystemPrompt() });

    // 追加历史对话记录
    for (const h of params.history) {
      messages.push(h);
    }

    // 当前用户消息，注入运行时上下文（时间、频道等）
    const userContent = this._injectRuntimeContext(
      params.currentMessage,
      params.channel,
      params.chatId,
    );
    messages.push({ role: 'user', content: userContent });

    return messages;
  }

  /**
   * 添加工具执行结果到消息列表
   */
  addToolResult(
    messages: SessionMessage[],
    toolCallId: string,
    toolName: string,
    result: string,
  ): SessionMessage[] {
    messages.push({
      role: 'tool',
      content: result,
      toolCallId,
      name: toolName,
    });
    return messages;
  }

  /**
   * 添加助手回复到消息列表（可能包含工具调用）
   */
  addAssistantMessage(
    messages: SessionMessage[],
    content: string | null,
    toolCalls?: ToolCallDict[],
  ): SessionMessage[] {
    const msg: SessionMessage = { role: 'assistant', content };
    if (toolCalls?.length) msg.toolCalls = toolCalls;
    messages.push(msg);
    return messages;
  }

  // ─── 私有辅助方法 ─────────────────────────────────────────────────────────

  /**
   * 生成 Agent 的核心身份提示词
   * 包含：运行环境、工作区路径、工具使用指南、记忆系统说明
   */
  private _identity(): string {
    const platform = os.platform() === 'darwin' ? 'macOS' : os.platform();
    const arch = os.arch();
    const nodeVersion = process.version;
    const ws = path.resolve(this._workspace);

    return `# minbot 🤖

You are openClawBot, a helpful AI assistant.

## Runtime
${platform} ${arch}, Node ${nodeVersion}

## Workspace
Your workspace is at: ${ws}
- Long-term memory: ${ws}/memory/MEMORY.md
- History log: ${ws}/memory/HISTORY.md (grep-searchable)
- Custom skills: ${ws}/skills/{skill-name}/SKILL.md

Reply directly with text for conversations. Only use the 'message' tool to send to a specific chat channel.

## Tool Call Guidelines
- Before calling tools, you may briefly state your intent, but NEVER predict the result before receiving it.
- Before modifying a file, read it first to confirm its current content.
- Do not assume a file or directory exists — use list_dir or read_file to verify.
- After writing or editing a file, re-read it if accuracy matters.
- If a tool call fails, analyze the error before retrying.

## Memory
- Remember important facts: write to ${ws}/memory/MEMORY.md
- Recall past events: exec \`grep "keyword" ${ws}/memory/HISTORY.md\``;
  }

  /**
   * 加载工作区根目录下的引导配置文件
   * 支持：AGENTS.md, SOUL.md, USER.md, TOOLS.md, IDENTITY.md
   */
  private _loadBootstrapFiles(): string {
    const parts: string[] = [];
    for (const filename of BOOTSTRAP_FILES) {
      const filePath = path.join(this._workspace, filename);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        parts.push(`## ${filename}\n\n${content}`);
      }
    }
    return parts.join('\n\n');
  }

  /**
   * 向用户消息注入运行时上下文
   * 包含：当前时间、时区、频道、会话 ID
   */
  private _injectRuntimeContext(
    userContent: string,
    channel?: string,
    chatId?: string,
  ): string {
    const now = new Date();
    const timeStr = now.toLocaleString('sv-SE').replace('T', ' ').slice(0, 16);
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const lines = [`Current Time: ${timeStr} (${weekday}, ${tz})`];
    if (channel) lines.push(`Channel: ${channel}`);
    if (chatId) lines.push(`Chat ID: ${chatId}`);

    return `${userContent}\n\n[Runtime Context]\n${lines.join('\n')}`;
  }
}
