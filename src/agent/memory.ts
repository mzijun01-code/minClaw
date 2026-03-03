/**
 * 双层记忆系统：
 *   MEMORY.md  — 长期记忆，存储重要事实，由 LLM 整理后更新
 *   HISTORY.md — 历史日志，按时间顺序记录，支持 grep 搜索
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../session/manager.js';
import type { LangChainProvider } from '../providers/langchain.js';
import type { OpenAIToolSchema } from '../types/index.js';

/**
 * 记忆保存工具定义
 * LLM 通过调用此工具来保存整理后的记忆
 */
const SAVE_MEMORY_TOOL: OpenAIToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save the memory consolidation result to persistent storage.',
      parameters: {
        type: 'object',
        properties: {
          history_entry: {
            type: 'string',
            description:
              'A paragraph (2-5 sentences) summarizing key events/decisions/topics. ' +
              'Start with [YYYY-MM-DD HH:MM]. Include detail useful for grep search.',
          },
          memory_update: {
            type: 'string',
            description:
              'Full updated long-term memory as markdown. Include all existing ' +
              'facts plus new ones. Return unchanged if nothing new.',
          },
        },
        required: ['history_entry', 'memory_update'],
      },
    },
  },
];

/**
 * 记忆存储类
 * 管理长期记忆 (MEMORY.md) 和历史日志 (HISTORY.md)
 */
export class MemoryStore {
  private readonly _memoryDir: string;    // 记忆目录路径
  private readonly _memoryFile: string;   // 长期记忆文件路径
  private readonly _historyFile: string;  // 历史日志文件路径

  constructor(workspace: string) {
    this._memoryDir = path.join(workspace, 'memory');
    fs.mkdirSync(this._memoryDir, { recursive: true });
    this._memoryFile = path.join(this._memoryDir, 'MEMORY.md');
    this._historyFile = path.join(this._memoryDir, 'HISTORY.md');
  }

  /** 读取长期记忆内容 */
  readLongTerm(): string {
    return fs.existsSync(this._memoryFile)
      ? fs.readFileSync(this._memoryFile, 'utf-8')
      : '';
  }

  /** 写入长期记忆（覆盖） */
  writeLongTerm(content: string): void {
    fs.writeFileSync(this._memoryFile, content, 'utf-8');
  }

  /** 追加历史日志条目 */
  appendHistory(entry: string): void {
    fs.appendFileSync(this._historyFile, entry.trimEnd() + '\n\n', 'utf-8');
  }

  /** 获取记忆上下文（用于注入系统提示词） */
  getMemoryContext(): string {
    const longTerm = this.readLongTerm();
    return longTerm ? `## Long-term Memory\n${longTerm}` : '';
  }

  /**
   * 记忆整理：将旧消息通过 LLM 整理到 MEMORY.md 和 HISTORY.md
   * 
   * 工作流程：
   *   1. 提取待整理的消息（保留最近 memoryWindow/2 条）
   *   2. 将消息格式化为文本，连同当前记忆发送给 LLM
   *   3. LLM 调用 save_memory 工具返回整理结果
   *   4. 更新 MEMORY.md 和 HISTORY.md
   * 
   * @param session 会话对象
   * @param options.archiveAll 是否归档所有消息（用于 /new 命令）
   * @param options.memoryWindow 记忆窗口大小
   * @returns 成功返回 true，失败返回 false
   */
  async consolidate(
    session: Session,
    provider: LangChainProvider,
    model: string,
    options: { archiveAll?: boolean; memoryWindow?: number } = {},
  ): Promise<boolean> {
    const { archiveAll = false, memoryWindow = 50 } = options;

    let oldMessages = session.messages;
    let keepCount = 0;

    if (!archiveAll) {
      // 计算要保留的消息数（窗口的一半）
      keepCount = Math.floor(memoryWindow / 2);
      if (session.messages.length <= keepCount) return true;
      if (session.messages.length - session.lastConsolidated <= 0) return true;
      // 提取需要整理的消息（从上次整理位置到保留区之前）
      oldMessages = session.messages.slice(session.lastConsolidated, -keepCount);
      if (oldMessages.length === 0) return true;
      console.log(
        `[Memory] Consolidating: ${oldMessages.length} messages, keeping ${keepCount}`,
      );
    } else {
      console.log(`[Memory] Archive all: ${session.messages.length} messages`);
    }

    // 将消息格式化为易读的文本格式
    const lines = oldMessages
      .filter((m) => m.content)
      .map((m) => {
        const toolsStr = m.toolsUsed?.length ? ` [tools: ${m.toolsUsed.join(', ')}]` : '';
        const ts = m.timestamp?.slice(0, 16) ?? '?';
        return `[${ts}] ${m.role.toUpperCase()}${toolsStr}: ${m.content}`;
      });

    const currentMemory = this.readLongTerm();
    const prompt = `Process this conversation and call the save_memory tool with your consolidation.

## Current Long-term Memory
${currentMemory || '(empty)'}

## Conversation to Process
${lines.join('\n')}`;

    try {
      const response = await provider.chat(
        [
          {
            role: 'system',
            content:
              'You are a memory consolidation agent. Call the save_memory tool with your consolidation of the conversation.',
          },
          { role: 'user', content: prompt },
        ],
        SAVE_MEMORY_TOOL,
        model,
      );

      if (response.toolCalls.length === 0) {
        console.warn('[Memory] LLM did not call save_memory, skipping');
        return false;
      }

      const args = response.toolCalls[0].arguments as {
        history_entry?: string;
        memory_update?: string;
      };

      if (args.history_entry) {
        this.appendHistory(String(args.history_entry));
      }
      if (args.memory_update) {
        const update = String(args.memory_update);
        if (update !== currentMemory) {
          this.writeLongTerm(update);
        }
      }

      session.lastConsolidated = archiveAll
        ? 0
        : session.messages.length - keepCount;

      console.log(
        `[Memory] Done. messages=${session.messages.length}, lastConsolidated=${session.lastConsolidated}`,
      );
      return true;
    } catch (err) {
      console.error('[Memory] Consolidation failed:', err);
      return false;
    }
  }
}
