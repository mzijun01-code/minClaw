/**
 * SubagentManager — 子代理管理器，用于在后台生成轻量级 Agent 实例
 *
 * 子代理与主 Agent 循环并行运行：
 *   - 拥有独立的工具集（不包含 message/spawn 工具，防止无限嵌套）
 *   - 专注完成单一任务，完成后向消息总线注入系统消息
 *   - 主 Agent 接收系统消息并为用户总结结果
 */

import { randomUUID } from 'node:crypto';
import type { MessageBus } from '../bus/queue.js';
import type { LangChainProvider } from '../providers/langchain.js';
import type { InboundMessage, SessionMessage, ToolCallDict } from '../types/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from '../tools/filesystem.js';
import { ExecTool } from '../tools/shell.js';
import { WebSearchTool, WebFetchTool } from '../tools/web.js';

/** 生成短 ID（8 位十六进制） */
function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/** 子代理生成选项 */
export interface SpawnOptions {
  task: string;           // 任务描述
  label?: string;         // 任务标签（用于日志和通知）
  originChannel?: string; // 发起请求的频道
  originChatId?: string;  // 发起请求的会话 ID
}

export class SubagentManager {
  // 正在运行的子代理任务映射：taskId -> Promise
  private readonly _running = new Map<string, Promise<void>>();

  constructor(
    private readonly _provider: LangChainProvider,   // LLM 提供者
    private readonly _workspace: string,             // 工作区路径
    private readonly _bus: MessageBus,               // 消息总线
    private readonly _model?: string,                // 模型名称
    private readonly _braveApiKey?: string,          // Brave 搜索 API Key
    private readonly _restrictToWorkspace = false,   // 是否限制在工作区内
  ) { }

  /**
   * 生成子代理执行后台任务
   * 立即返回状态消息，任务在后台异步执行
   */
  spawn(options: SpawnOptions): string {
    const taskId = shortId();
    const label = options.label ?? (options.task.slice(0, 30) + (options.task.length > 30 ? '...' : ''));
    const channel = options.originChannel ?? 'cli';
    const chatId = options.originChatId ?? 'direct';

    const promise = this._runSubagent(taskId, options.task, label, channel, chatId);
    this._running.set(taskId, promise);
    promise.finally(() => this._running.delete(taskId));

    console.log(`[Subagent] Spawned [${taskId}]: ${label}`);
    return `Subagent [${label}] started (id: ${taskId}). I'll notify you when it completes.`;
  }

  /** 获取当前运行中的子代理数量 */
  get runningCount(): number {
    return this._running.size;
  }

  /**
   * 执行子代理任务
   * 循环调用 LLM，处理工具调用，完成后通过消息总线通知主 Agent
   */
  private async _runSubagent(
    taskId: string,
    task: string,
    label: string,
    channel: string,
    chatId: string,
  ): Promise<void> {
    console.log(`[Subagent ${taskId}] Starting: ${label}`);

    try {
      // 构建子代理专用工具集和系统提示词
      const tools = this._buildTools();
      const systemPrompt = this._buildPrompt();
      const messages: SessionMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task },
      ];

      // 子代理最多执行 15 次工具调用
      const maxIter = 15;
      let finalResult: string | null = null;

      for (let i = 0; i < maxIter; i++) {
        const response = await this._provider.chat(
          messages,
          tools.getDefinitions(),
          this._model,
        );

        if (response.toolCalls.length > 0) {
          const toolCallDicts: ToolCallDict[] = response.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));

          messages.push({
            role: 'assistant',
            content: response.content ?? '',
            toolCalls: toolCallDicts,
          });

          for (const tc of response.toolCalls) {
            console.log(`[Subagent ${taskId}] Tool: ${tc.name}`);
            const result = await tools.execute(tc.name, tc.arguments);
            messages.push({
              role: 'tool',
              content: result,
              toolCallId: tc.id,
              name: tc.name,
            });
          }
        } else {
          finalResult = response.content;
          break;
        }
      }

      const result = finalResult ?? 'Task completed but no final response was generated.';
      console.log(`[Subagent ${taskId}] Completed`);
      await this._announce(taskId, label, task, result, channel, chatId, 'ok');
    } catch (err) {
      const errMsg = `Error: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Subagent ${taskId}] Failed:`, err);
      await this._announce(taskId, label, task, errMsg, channel, chatId, 'error');
    }
  }

  /**
   * 向消息总线发布子代理完成通知
   * 通知会作为系统消息被主 Agent 接收并处理
   */
  private async _announce(
    taskId: string,
    label: string,
    task: string,
    result: string,
    channel: string,
    chatId: string,
    status: 'ok' | 'error',
  ): Promise<void> {
    const statusText = status === 'ok' ? 'completed successfully' : 'failed';
    const content = `[Subagent '${label}' ${statusText}]

Task: ${task}

Result:
${result}

Summarize this naturally for the user. Keep it brief (1-2 sentences). Do not mention technical details like "subagent" or task IDs.`;

    const msg: InboundMessage = {
      channel: 'system',
      senderId: 'subagent',
      chatId: `${channel}:${chatId}`,
      content,
      timestamp: new Date(),
    };

    await this._bus.publishInbound(msg);
  }

  /**
   * 构建子代理工具集
   * 包含：文件操作、Shell、Web 搜索/抓取
   * 不包含：message（防止直接发消息）、spawn（防止无限嵌套）
   */
  private _buildTools(): ToolRegistry {
    const reg = new ToolRegistry();
    const allowed = this._restrictToWorkspace ? this._workspace : undefined;

    reg.register(new ReadFileTool(this._workspace, allowed));
    reg.register(new WriteFileTool(this._workspace, allowed));
    reg.register(new EditFileTool(this._workspace, allowed));
    reg.register(new ListDirTool(this._workspace, allowed));
    reg.register(new ExecTool({
      workingDir: this._workspace,
      restrictToWorkspace: this._restrictToWorkspace,
    }));
    reg.register(new WebSearchTool(this._braveApiKey));
    reg.register(new WebFetchTool());

    return reg;
  }

  /** 构建子代理专用系统提示词 */
  private _buildPrompt(): string {
    const now = new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 16);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    return `# Subagent

## Current Time
${now} (${tz})

You are a subagent spawned by the main agent to complete a specific task.

## Rules
1. Stay focused — complete only the assigned task, nothing else
2. Your final response will be reported back to the main agent
3. Do not initiate conversations or take on side tasks
4. Be concise but informative in your findings

## Capabilities
- Read and write files in the workspace
- Execute shell commands
- Search the web and fetch web pages

## Limitations
- No direct user messaging (no message tool)
- Cannot spawn other subagents

## Workspace
${this._workspace}

When done, provide a clear summary of your findings or actions.`;
  }
}
