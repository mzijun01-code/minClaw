/**
 * AgentLoop — Agent 核心处理引擎
 *
 * 每条消息的处理流程：
 *   1. 从消息总线接收 InboundMessage
 *   2. 处理斜杠命令 (/new 新建会话, /help 帮助)
 *   3. 按需触发后台记忆整理 (非阻塞)
 *   4. 构建上下文 (系统提示词 + 历史消息 + 当前消息)
 *   5. 循环调用 LLM (最多 maxIterations 次):
 *      a. 若有工具调用 → 执行工具，追加结果，继续循环
 *      b. 若无工具调用 → 结束，返回最终内容
 *   6. 保存本轮对话到会话
 *   7. 发布 OutboundMessage 到消息总线
 */

import type { MessageBus } from '../bus/queue.js';
import type { LangChainProvider } from '../providers/langchain.js';
import type { CronService } from '../cron/service.js';
import type { InboundMessage, OutboundMessage, SessionMessage, ToolCallDict } from '../types/index.js';
import { ContextBuilder } from './context.js';
import { SessionManager, Session, saveTurn } from '../session/manager.js';
import { SubagentManager } from './subagent.js';
import { ToolRegistry } from './tools/registry.js';
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from './tools/filesystem.js';
import { ExecTool } from './tools/shell.js';
import { WebSearchTool, WebFetchTool } from './tools/web.js';
import { MessageTool } from './tools/message.js';
import { SpawnTool } from './tools/spawn.js';
import { CronTool } from './tools/cron.js';

const DEBUG = Boolean(process.env.MINBOT_DEBUG);
const LOG_MESSAGES = Boolean(process.env.MINBOT_LOG_MESSAGES);

function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log('[DEBUG:loop]', ...args);
}

function logMessages(label: string, messages: SessionMessage[]): void {
  if (!LOG_MESSAGES) return;
  const tag = `\n${'═'.repeat(60)}\n[MSG:${label}] ${new Date().toISOString()}\n${'═'.repeat(60)}`;
  console.log(tag);
  for (const m of messages) {
    const role = m.role.toUpperCase().padEnd(9);
    if (m.role === 'system') {
      console.log(`  ${role} (${m.content?.length ?? 0} chars)`);
    } else if (m.role === 'tool') {
      const result = m.content && m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
      console.log(`  ${role} [${m.name}] ${result}`);
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls = m.toolCalls.map((tc) => tc.function.name).join(', ');
      const text = m.content ? ` "${m.content.slice(0, 80)}"` : '';
      console.log(`  ${role}${text} → tools: [${calls}]`);
    } else {
      const text = m.content && m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content;
      console.log(`  ${role} ${text}`);
    }
  }
  console.log('─'.repeat(60));
}

export interface AgentLoopOptions {
  workspace: string;
  provider: LangChainProvider;
  model?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  memoryWindow?: number;
  braveApiKey?: string;
  cronService?: CronService;
  restrictToWorkspace?: boolean;
  builtinSkillsDir?: string;
}

export class AgentLoop {
  private readonly _bus: MessageBus;              // 消息总线，用于收发消息
  private readonly _provider: LangChainProvider;  // LLM 提供者
  private readonly _model: string;                // 使用的模型名称
  private readonly _maxIterations: number;        // 单轮最大工具调用次数
  private readonly _memoryWindow: number;         // 记忆窗口大小（保留的历史消息数）
  private readonly _context: ContextBuilder;      // 上下文构建器
  private readonly _sessions: SessionManager;     // 会话管理器
  private readonly _tools: ToolRegistry;          // 工具注册表
  private readonly _subagents: SubagentManager;   // 子代理管理器
  private readonly _messageTool: MessageTool;     // 消息工具（用于主动发送消息）
  private _running = false;                       // 循环运行状态

  // 正在整理记忆的会话集合（防止重复整理）
  private readonly _consolidating = new Set<string>();

  constructor(bus: MessageBus, options: AgentLoopOptions) {
    this._bus = bus;
    this._provider = options.provider;
    this._model = options.model ?? options.provider.defaultModel;
    this._maxIterations = options.maxIterations ?? 60; // 单轮最大工具调用次数
    this._memoryWindow = options.memoryWindow ?? 100; 

    this._context = new ContextBuilder(options.workspace, options.builtinSkillsDir);
    this._sessions = new SessionManager(options.workspace);

    this._subagents = new SubagentManager(
      options.provider,
      options.workspace,
      bus,
      this._model,
      options.braveApiKey,
      options.restrictToWorkspace,
    );

    this._tools = new ToolRegistry();
    this._messageTool = new MessageTool();
    this._registerTools(options);
  }

  /**
   * 注册所有可用工具
   * 包括：文件操作、Shell 执行、Web 搜索/抓取、消息发送、子代理、定时任务
   */
  private _registerTools(options: AgentLoopOptions): void {
    const ws = options.workspace;
    const allowed = options.restrictToWorkspace ? ws : undefined; // 限制在 workspace 内

    // 文件系统工具
    this._tools.register(new ReadFileTool(ws, allowed));
    this._tools.register(new WriteFileTool(ws, allowed));
    this._tools.register(new EditFileTool(ws, allowed));
    this._tools.register(new ListDirTool(ws, allowed));

    // Shell 执行工具
    this._tools.register(new ExecTool({
      workingDir: ws,
      restrictToWorkspace: options.restrictToWorkspace,
    }));

    // Web 相关工具 Brave/Tavily 搜索
    this._tools.register(new WebSearchTool(options.braveApiKey));
    this._tools.register(new WebFetchTool());

    // 消息发送工具（支持向指定频道发送消息）
    this._messageTool.setSendCallback((msg) => this._bus.publishOutbound(msg));
    this._tools.register(this._messageTool);

    // 子代理生成工具 启动后台子代理任务
    const spawnTool = new SpawnTool(this._subagents);
    this._tools.register(spawnTool);

    // 定时任务工具（可选） 添加/列出/删除定时任务
    if (options.cronService) {
      this._tools.register(new CronTool(options.cronService));
    }
  }

  private _setToolContext(channel: string, chatId: string, messageId?: string): void {
    const msgTool = this._tools.get('message') as MessageTool | undefined;
    msgTool?.setContext(channel, chatId, messageId);

    const spawnTool = this._tools.get('spawn') as SpawnTool | undefined;
    spawnTool?.setContext(channel, chatId);

    const cronTool = this._tools.get('cron') as CronTool | undefined;
    cronTool?.setContext(channel, chatId);
  }

  /**
   * 启动 Agent 主循环
   * 持续从消息总线消费消息并处理，直到调用 stop()
   */
  async run(): Promise<void> {
    this._running = true;

    while (this._running) {
      // 直接等待消息总线（无超时竞争条件）
      // bus.consumeInbound() 会等待直到有消息到达
      const msg = await this._bus.consumeInbound();
      if (!this._running) break;

      debugLog('收到入站用户任务，开始处理...');
      try {
        const response = await this._processMessage(msg);
        debugLog('处理完成，响应用户...');
        if (response) {
          await this._bus.publishOutbound(response);
        } else if (msg.channel === 'cli') {
          // CLI 期望即使没有结果也要有响应
          await this._bus.publishOutbound({
            channel: msg.channel,
            chatId: msg.chatId,
            content: '',
            metadata: msg.metadata ?? {},
          });
        }
      } catch (err) {
        await this._bus.publishOutbound({
          channel: msg.channel,
          chatId: msg.chatId,
          content: `Sorry, I encountered an error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  stop(): void {
    this._running = false;
  }

  /**
   * 直接处理消息（供 CLI 或程序化调用使用）
   * 绕过消息总线，同步返回结果，不通过消息总线发布响应
   */
  async processDirect(
    content: string,
    options: {
      sessionKey?: string;
      channel?: string;
      chatId?: string;
      onProgress?: (text: string, isToolHint?: boolean) => void;
    } = {},
  ): Promise<string> {
    const channel = options.channel ?? 'cli';
    const chatId = options.chatId ?? 'direct';
    const msg: InboundMessage = {
      channel,
      senderId: 'user',
      chatId,
      content,
      timestamp: new Date(),
      sessionKeyOverride: options.sessionKey,
    };
    const response = await this._processMessage(msg, options.onProgress);
    return response?.content ?? '';
  }

  // ─── 核心处理逻辑 ──────────────────────────────────────────────────────────

  /**
   * 处理单条入站消息
   * 返回出站消息，或 null（如果已通过 message 工具发送）
   */
  private async _processMessage(
    msg: InboundMessage,
    onProgress?: (text: string, isToolHint?: boolean) => void,
  ): Promise<OutboundMessage | null> {
    // 系统消息（来自子代理）：从 chatId 解析原始频道（格式："channel:chatId"）
    if (msg.channel === 'system') {
      return this._processSystemMessage(msg);
    }

    const preview = msg.content.length > 80
      ? msg.content.slice(0, 80) + '...'
      : msg.content;

    // 获取或创建会话（支持通过 sessionKeyOverride 自定义会话键）
    const sessionKey = msg.sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`;
    const session = this._sessions.getOrCreate(sessionKey);

    // 斜杠命令处理 /new 新建会话 /help 帮助
    const cmd = msg.content.trim().toLowerCase();
    if (cmd === '/new') {
      return this._handleNewSession(msg, session);
    }
    if (cmd === '/help') {
      return {
        channel: msg.channel,
        chatId: msg.chatId,
        content: '🤖 minbot commands:\n/new — Start a new conversation\n/help — Show available commands',
      };
    }

    // 按需触发后台记忆整理（非阻塞）
    // 当未整理的消息数达到记忆窗口大小时触发 触发后台记忆整理
    const unconsolidated = session.messages.length - session.lastConsolidated;
    if (unconsolidated >= this._memoryWindow && !this._consolidating.has(session.key)) {
      this._consolidating.add(session.key);
      this._context.memory
        .consolidate(session, this._provider, this._model, {
          memoryWindow: this._memoryWindow,
        })
        .catch((err) => console.error('[Memory] Background consolidation failed:', err))
        .finally(() => this._consolidating.delete(session.key));
    }

    // 设置有状态工具的上下文（频道、会话 ID）
    this._setToolContext(msg.channel, msg.chatId, msg.metadata?.['message_id'] as string);
    this._messageTool.startTurn();  // 重置本轮消息发送状态

    const history = session.getHistory(this._memoryWindow);
    const initialMessages = this._context.buildMessages({
      history,
      currentMessage: msg.content,
      channel: msg.channel,
      chatId: msg.chatId,
    });

    // 进度回调：通过消息总线发送中间状态
    const busProgress = async (text: string, isToolHint = false): Promise<void> => {
      const meta = { ...(msg.metadata ?? {}), _progress: true, _toolHint: isToolHint };
      await this._bus.publishOutbound({ channel: msg.channel, chatId: msg.chatId, content: text, metadata: meta });
    };

    const progressFn = onProgress
      ? (t: string, h?: boolean) => { onProgress(t, h); return Promise.resolve(); }
      : busProgress;

    // 显示"思考中"提示，让用户知道正在等待 LLM 响应
    await progressFn('Thinking...', false);
    const { finalContent, allMessages } = await this._runAgentLoop(initialMessages, progressFn);

    // 保存本轮对话到会话
    saveTurn(session, allMessages, 1 + history.length);
    this._sessions.save(session);

    const reply = finalContent ?? "处理完成，但无响应可提供。";
    // 如果本轮已通过 message 工具发送了消息，则不重复发送响应
    if (this._messageTool.sentInTurn) return null;

    return { channel: msg.channel, chatId: msg.chatId, content: reply, metadata: msg.metadata ?? {} };
  }

  /**
   * 处理系统消息（通常来自子代理完成的任务报告）
   */
  private async _processSystemMessage(msg: InboundMessage): Promise<OutboundMessage> {
    const [channel, chatId] = msg.chatId.includes(':')
      ? msg.chatId.split(':', 2) as [string, string]
      : ['cli', msg.chatId];

    const sessionKey = `${channel}:${chatId}`;
    const session = this._sessions.getOrCreate(sessionKey);
    this._setToolContext(channel, chatId);

    const history = session.getHistory(this._memoryWindow);
    const messages = this._context.buildMessages({
      history,
      currentMessage: msg.content,
      channel,
      chatId,
    });

    const { finalContent, allMessages } = await this._runAgentLoop(messages);
    saveTurn(session, allMessages, 1 + history.length);
    this._sessions.save(session);

    return {
      channel,
      chatId,
      content: finalContent ?? 'Background task completed.',
    };
  }

  /**
   * 处理 /new 命令：整理当前会话记忆并清空会话
   */
  private async _handleNewSession(
    msg: InboundMessage,
    session: Session,
  ): Promise<OutboundMessage> {
    const snapshot = session.messages.slice(session.lastConsolidated);
    if (snapshot.length > 0) {
      const tmpSession = new Session(session.key, snapshot);
      const ok = await this._context.memory.consolidate(tmpSession, this._provider, this._model, {
        archiveAll: true,
        memoryWindow: this._memoryWindow,
      });
      if (!ok) {
        return {
          channel: msg.channel,
          chatId: msg.chatId,
          content: 'Memory archival failed. Session not cleared. Please try again.',
        };
      }
    }

    session.clear();
    this._sessions.save(session);
    this._sessions.invalidate(session.key);

    return { channel: msg.channel, chatId: msg.chatId, content: 'New session started.' };
  }

  // ─── Agent 循环核心 ───────────────────────────────────────────────────────────

  /**
   * 执行 Agent 循环：反复调用 LLM，处理工具调用，直到获得最终响应
   * @returns finalContent 最终文本响应，allMessages 完整消息列表
   */
  private async _runAgentLoop(
    initialMessages: SessionMessage[],
    onProgress?: (text: string, isToolHint?: boolean) => Promise<void>,
  ): Promise<{ finalContent: string | null; allMessages: SessionMessage[] }> {
    let messages = initialMessages;
    let finalContent: string | null = null;

    for (let i = 0; i < this._maxIterations; i++) {
      debugLog(`provider.chat() call start (iteration ${i + 1}/${this._maxIterations})`);
      logMessages(`iter-${i + 1} request`, messages);

      this._printConversation(i + 1, messages);

      const response = await this._provider.chat(
        messages,
        this._tools.getDefinitions(),
        this._model,
      );

      if (LOG_MESSAGES) {
        const calls = response.toolCalls.map((tc) => tc.name);
        console.log(`[MSG:iter-${i + 1} response] content=${response.content?.length ?? 0} chars, tools=[${calls.join(', ')}]`);
      }

      if (response.toolCalls.length > 0) {
        // Send progress if any content
        if (onProgress) {
          const clean = this._stripThink(response.content);
          if (clean) await onProgress(clean);
          await onProgress(this._toolHint(response.toolCalls), true);
        }

        const toolCallDicts: ToolCallDict[] = response.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));

        messages = this._context.addAssistantMessage(messages, response.content, toolCallDicts);

        for (const tc of response.toolCalls) {
          console.log(`[Agent] Tool: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)})`);
          const result = await this._tools.execute(tc.name, tc.arguments);
          messages = this._context.addToolResult(messages, tc.id, tc.name, result);
        }
      } else {
        finalContent = this._stripThink(response.content);
        break;
      }
    }

    if (finalContent === null) {
      console.warn(`[Agent] Max iterations (${this._maxIterations}) reached`);
      finalContent =
        `I reached the maximum number of tool call iterations (${this._maxIterations}) ` +
        'without completing the task. Try breaking the task into smaller steps.';
    }

    return { finalContent, allMessages: messages };
  }

  /**
   * 在每次调用远程模型前，打印完整的对话历史（原始结构）
   */
  private _printConversation(iteration: number, messages: SessionMessage[]): void {
    console.dir(`\n[对话历史] iteration=${iteration}/${this._maxIterations} model=${this._model} messages=${messages.length} time=${new Date().toISOString()}`, { depth: null });
    console.log(JSON.stringify(messages, null, 2));
  }

  /**
   * 移除 <think>...</think> 标签（用于隐藏 LLM 的思考过程）
   */
  private _stripThink(text: string | null): string | null {
    if (!text) return null;
    const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return stripped || null;
  }

  /**
   * 生成工具调用提示文本，用于向用户显示正在执行的操作
   */
  private _toolHint(
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
  ): string {
    return toolCalls
      .map((tc) => {
        const firstVal = Object.values(tc.arguments)[0];
        if (typeof firstVal === 'string') {
          const display = firstVal.length > 40 ? firstVal.slice(0, 40) + '…' : firstVal;
          return `${tc.name}("${display}")`;
        }
        return tc.name;
      })
      .join(', ');
  }
}
