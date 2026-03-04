# minbot 设计文档

> 基于 openClaw nanobot 复刻，以 LangChain + TypeScript 为核心的个人AI助手

---

## 一、项目概述

**minbot** 是 openClaw 的 Node + langChain 版本，保留原版核心能力，并通过 TypeScript + LangChain 获得更好的类型安全与生态整合，利用前端同学，打造成一个可扩展的个人AI助手。

### 核心目标
1. 完整 openClawBot 功能：消息总线、代理循环、记忆、技能、工具、子代理、定时任务
2. 使用 LangChain 统一管理 LLM 调用（支持 OpenAI / Anthropic / 任意 OpenAI 兼容接口）
3. TypeScript 严格类型，代码可读性与维护性优先
4. 可通过 CLI 直接运行，架构为后续接入渠道（Telegram/Discord等）预留扩展点

---

## 二、架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                          minbot                                  │
│                                                                  │
│  CLI / Channel ──► MessageBus (inbound queue)                   │
│                                                                  │
│  AgentLoop ◄──── MessageBus                                      │
│     │                                                            │
│     ├── ContextBuilder ──► SystemPrompt                          │
│     │     ├── MemoryStore  (MEMORY.md + HISTORY.md)             │
│     │     └── SkillsLoader (SKILL.md files)                      │
│     │                                                            │
│     ├── LangChainProvider ──► LLM API                           │
│     │                                                            │
│     ├── ToolRegistry ──► [Tools]                                 │
│     │     ├── ReadFile / WriteFile / EditFile / ListDir          │
│     │     ├── Exec (shell)                                       │
│     │     ├── WebSearch / WebFetch                               │
│     │     ├── Message (send to channel)                          │
│     │     ├── Spawn (subagent)                                   │
│     │     └── Cron (schedule)                                    │
│     │                                                            │
│     ├── SessionManager ──► sessions/*.jsonl                      │
│     └── SubagentManager ──► background tasks                     │
│                                                                  │
│  AgentLoop ──► MessageBus (outbound queue) ──► CLI / Channel    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、目录结构

```
minbot/
├── src/
│   ├── types/
│   │   └── index.ts            # 共享类型定义（接口/类型别名）
│   │
│   ├── bus/
│   │   ├── events.ts           # InboundMessage / OutboundMessage
│   │   └── queue.ts            # MessageBus（异步队列）
│   │
│   ├── session/
│   │   └── manager.ts          # Session + SessionManager（JSONL持久化）
│   │
│   ├── agent/
│   │   ├── memory.ts           # MemoryStore（MEMORY.md + HISTORY.md）
│   │   ├── skills.ts           # SkillsLoader（SKILL.md 文件扫描）
│   │   ├── context.ts          # ContextBuilder（组装 system prompt）
│   │   ├── subagent.ts         # SubagentManager（后台任务）
│   │   └── loop.ts             # AgentLoop（核心处理引擎）
│   │
│   ├── tools/
│   │   ├── base.ts             # Tool 抽象基类
│   │   ├── registry.ts         # ToolRegistry（注册 + 执行）
│   │   ├── filesystem.ts       # ReadFile / WriteFile / EditFile / ListDir
│   │   ├── shell.ts            # ExecTool（shell 命令执行）
│   │   ├── web.ts              # WebSearchTool / WebFetchTool
│   │   ├── message.ts          # MessageTool（发消息给用户）
│   │   ├── spawn.ts            # SpawnTool（启动子代理）
│   │   └── cron.ts             # CronTool（定时任务管理）
│   │
│   ├── cron/
│   │   ├── types.ts            # CronSchedule 类型
│   │   └── service.ts          # CronService（node-cron 封装）
│   │
│   ├── providers/
│   │   └── langchain.ts        # LangChainProvider（统一 LLM 接口）
│   │
│   ├── cli/
│   │   └── index.ts            # CLI 交互（readline + 流式输出）
│   │
│   └── index.ts                # 主入口（组装并启动）
│
├── package.json
├── tsconfig.json
├── .env.example
└── DESIGN.md                   # 本文档
```

---

## 四、核心模块设计

### 4.1 消息总线（MessageBus）

**职责**：解耦渠道（Channel）与代理（Agent）的通信。

```typescript
// 入站消息：从渠道流向代理
interface InboundMessage {
  channel: string;      // 'cli' | 'telegram' | 'discord' ...
  senderId: string;     // 用户标识
  chatId: string;       // 会话/聊天标识
  content: string;      // 消息正文
  timestamp: Date;
  media?: string[];     // 媒体文件路径
  metadata?: Record<string, any>;
  sessionKeyOverride?: string;
  readonly sessionKey: string;  // channel:chatId
}

// 出站消息：从代理流向渠道
interface OutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string;
  media?: string[];
  metadata?: Record<string, any>;
}
```

使用 Node.js 原生 EventEmitter + 手工 Promise 队列模拟 asyncio.Queue 的行为。

### 4.2 会话管理器（SessionManager）

**职责**：管理多用户的对话历史，持久化为 JSONL 文件。

- 文件路径：`{workspace}/sessions/{channel}_{chatId}.jsonl`
- 第一行为 metadata 行（`_type: "metadata"`）
- 后续每行为一条消息
- 内存缓存防止重复 IO
- 支持 `get_or_create`, `save`, `invalidate`, `list`

关键设计点：
- `lastConsolidated: number` — 记录已归档到 MEMORY.md 的消息数量边界
- `getHistory(maxMessages)` — 只返回未归档消息，并确保从 user 消息开始

### 4.3 记忆系统（MemoryStore）

**职责**：两层记忆，让 Agent 跨会话记住关键信息。

```
{workspace}/memory/
├── MEMORY.md   # 长期事实（LLM 可读，随对话更新）
└── HISTORY.md  # 历史日志（可 grep 检索的时间轴记录）
```

**归档流程**：
1. 当未归档消息数 >= `memory_window` 时触发
2. 调用 LLM，传入当前对话片段 + 现有 MEMORY.md
3. LLM 通过 `save_memory` 工具调用返回：`history_entry` + `memory_update`
4. 追加 history_entry 到 HISTORY.md，覆写 MEMORY.md
5. 更新 `session.lastConsolidated`

### 4.4 技能加载器（SkillsLoader）

**职责**：扫描 `{workspace}/skills/` 目录，加载 SKILL.md 文件。

- 支持 YAML frontmatter（`description`, `requires.bins`, `requires.env`, `always`）
- `always=true` 的技能自动注入 system prompt
- 其他技能以摘要形式展示，Agent 可按需用 `read_file` 工具加载

### 4.5 上下文构建器（ContextBuilder）

**职责**：组装完整的 LLM 上下文（system prompt + 历史消息）。

System Prompt 结构：
```
# minbot 🤖

## Runtime
{OS} {arch}, Node {version}

## Workspace
workspace: {path}
memory: {path}/memory/MEMORY.md
history: {path}/memory/HISTORY.md
skills: {path}/skills/{name}/SKILL.md

...工具使用指南...

---

## 自定义文件 (AGENTS.md, SOUL.md, USER.md, TOOLS.md)

---

## 长期记忆 (MEMORY.md)

---

## 常驻技能 (always=true)

---

## 可用技能列表 (摘要)
```

每条用户消息末尾注入运行时上下文：
```
[Runtime Context]
Current Time: 2026-02-25 14:30 (Wednesday)
Channel: cli
Chat ID: direct
```

### 4.6 LangChain 提供者（LangChainProvider）

**职责**：封装 LLM 调用，对上层暴露统一的 `chat()` 接口。

使用 `@langchain/openai` 的 `ChatOpenAI`（兼容所有 OpenAI 格式接口）：

```typescript
interface LLMResponse {
  content: string | null;
  toolCalls: ToolCallRequest[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
}

interface LangChainProviderOptions {
  apiKey: string;
  apiBase?: string;      // 支持自定义 base url（Ollama、国内服务等）
  model: string;
  temperature?: number;
  maxTokens?: number;
}
```

工具格式转换：内部 Tool → LangChain Tool Schema → OpenAI function format

**错误处理**：捕获所有 LLM 错误，返回 `content: "Error: ..."` 而不抛出，保证 Agent Loop 健壮运行。

### 4.7 工具系统（Tools）

所有工具继承 `Tool` 抽象基类：

```typescript
abstract class Tool {
  abstract name: string;
  abstract description: string;
  abstract parameters: JSONSchema;
  abstract execute(args: Record<string, any>): Promise<string>;

  toSchema(): OpenAIToolSchema { ... }    // 转换为 LLM function definition
  validateParams(args: Record<string, any>): string[];  // 参数校验
}
```

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 写入/创建文件（自动创建父目录） |
| `edit_file` | 精确替换文件中的文本 |
| `list_dir` | 列出目录内容 |
| `exec` | 执行 shell 命令（带危险命令过滤） |
| `web_search` | Brave Search API 搜索 |
| `web_fetch` | 抓取网页并提取可读内容 |
| `message` | 发送消息给用户（通过 bus） |
| `spawn` | 启动后台子代理任务 |
| `cron` | 添加/列出/删除定时任务 |

**ExecTool 安全规则**（与 openclaw nanobot 一致）：
- 拦截 `rm -rf`, `dd if=`, `shutdown`, fork bomb 等危险模式
- 可选 `restrict_to_workspace`：阻止路径遍历
- 输出截断：超过 10000 字符则截断

**WebFetchTool**：
- URL 验证（仅允许 http/https）
- HTML → Markdown 转换（正则提取链接、标题、列表）
- 可配置最大字符数（默认 50000）

### 4.8 子代理管理器（SubagentManager）

**职责**：将耗时任务派发给后台独立 Agent，完成后通过 bus 汇报结果。

```
主 Agent 调用 spawn(task) 
  → SubagentManager 创建独立任务（Promise）
  → 子代理运行独立工具集（无 message/spawn 工具）
  → 完成后向 bus 注入 system 消息
  → 主 Agent 处理 system 消息，汇总给用户
```

子代理最大迭代 15 次，有独立的系统 prompt。

### 4.9 代理循环（AgentLoop）

**职责**：核心处理引擎，读取消息 → 构建上下文 → 调用 LLM → 执行工具 → 发送响应。

```typescript
async run(): Promise<void> {
  while (running) {
    const msg = await bus.consumeInbound();
    const response = await processMessage(msg);
    if (response) await bus.publishOutbound(response);
  }
}
```

**消息处理流程**：
1. 解析 session key，获取或创建 Session
2. 处理斜杠命令（`/new`, `/help`）
3. 检查是否需要触发记忆归档（后台异步）
4. 构建 messages（system prompt + history + current）
5. 运行 `_runAgentLoop`（最多 40 次迭代）：
   - 调用 LLM
   - 如有工具调用：执行工具，追加结果，继续迭代
   - 如无工具调用：返回最终回复
6. 保存新消息到 session
7. 返回 OutboundMessage

### 4.10 Cron 服务（CronService）

**职责**：管理定时任务，支持三种模式：

| 模式 | 参数 | 说明 |
|------|------|------|
| `every` | `everyMs` | 固定间隔重复 |
| `cron` | `expr` | Cron 表达式（使用 node-cron） |
| `at` | `atMs` | 单次定时执行 |

任务持久化到 `{workspace}/cron/jobs.json`，重启后自动恢复。

---

## 五、数据流

### 5.1 CLI 消息流

```
用户输入
  ↓
CLI readline
  ↓
bus.publishInbound(InboundMessage)
  ↓
AgentLoop.run() 读取
  ↓
_processMessage()
  ↓
buildMessages() → LLM → executeTools() → ...
  ↓
bus.publishOutbound(OutboundMessage)
  ↓
CLI 打印响应
```

### 5.2 记忆归档流

```
processMessage() 检测 unconsolidated >= memory_window
  ↓
异步触发 _consolidateMemory()（不阻塞当前消息处理）
  ↓
MemoryStore.consolidate()
  ↓
调用 LLM with save_memory tool
  ↓
写入 MEMORY.md + HISTORY.md
  ↓
session.lastConsolidated 更新
```

---

## 六、依赖清单

```json
{
  "dependencies": {
    "@langchain/openai": "^0.3.x",    // LLM 调用（兼容 OpenAI 接口）
    "@langchain/core": "^0.3.x",      // LangChain 核心
    "node-cron": "^3.x",              // Cron 表达式调度
    "axios": "^1.x",                  // HTTP 请求（web_fetch）
    "cheerio": "^1.x",                // HTML 解析（web_fetch）
    "dotenv": "^16.x",                // 环境变量加载
    "chalk": "^5.x",                  // CLI 彩色输出
    "ora": "^8.x"                     // CLI 加载动画
  },
  "devDependencies": {
    "typescript": "^5.x",
    "tsx": "^4.x",                    // 直接运行 TS 文件
    "@types/node": "^22.x",
    "@types/node-cron": "^3.x"
  }
}
```

---

## 七、环境变量

```bash
# LLM 配置（必填其一）
OPENAI_API_KEY=sk-...
OPENAI_API_BASE=https://api.openai.com/v1   # 可自定义（如 Ollama）
MODEL=gpt-4o                                 # 默认模型

# 或 Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# 工具配置
BRAVE_API_KEY=...       # web_search 工具（可选）

# 工作区
WORKSPACE=~/.minbot    # 默认工作区路径
```

---

## 八、实现顺序

按依赖关系从底层到顶层依次实现：

1. ✅ 设计文档
2. 项目配置（package.json, tsconfig.json）
3. 类型定义（types/index.ts）
4. 消息总线（bus/）
5. 会话管理器（session/manager.ts）
6. 记忆系统（agent/memory.ts）
7. 技能加载器（agent/skills.ts）
8. 工具基类 + 注册表（tools/base.ts, tools/registry.ts）
9. 所有工具（tools/*.ts）
10. LangChain 提供者（providers/langchain.ts）
11. 上下文构建器（agent/context.ts）
12. 子代理管理器（agent/subagent.ts）
13. 代理循环（agent/loop.ts）
14. Cron 服务（cron/service.ts）
15. CLI 入口（cli/index.ts + index.ts）

---
