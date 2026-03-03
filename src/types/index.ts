/**
 * Shared type definitions for minbot
 */

// ─── Message Types ────────────────────────────────────────────────────────────

export interface InboundMessage {
  channel: string;
  senderId: string;
  chatId: string;
  content: string;
  timestamp: Date;
  media?: string[];
  metadata?: Record<string, unknown>;
  sessionKeyOverride?: string;
}

export function getSessionKey(msg: InboundMessage): string {
  return msg.sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`;
}

export interface OutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string;
  media?: string[];
  metadata?: Record<string, unknown>;
}

// ─── LLM Types ────────────────────────────────────────────────────────────────

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCallRequest[];
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  reasoningContent?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCallDict[];
  toolCallId?: string;
  name?: string;
  reasoningContent?: string;
  timestamp?: string;
}

export interface ToolCallDict {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ─── Tool Types ───────────────────────────────────────────────────────────────

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: JSONSchemaProperty;
  default?: unknown;
  [key: string]: unknown;
}

export interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
  cache_control?: { type: string };
}

// ─── Session Types ────────────────────────────────────────────────────────────

export interface SessionMessage {
  role: string;
  content: string | null;
  toolCalls?: ToolCallDict[];
  toolCallId?: string;
  name?: string;
  timestamp?: string;
  toolsUsed?: string[];
}

export interface SessionMetadata {
  _type: 'metadata';
  key: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  lastConsolidated: number;
}

// ─── Cron Types ───────────────────────────────────────────────────────────────

export type CronKind = 'every' | 'cron' | 'at';

export interface CronSchedule {
  kind: CronKind;
  everyMs?: number;    // for 'every'
  expr?: string;       // for 'cron'
  tz?: string;         // for 'cron' with timezone
  atMs?: number;       // for 'at' (unix ms)
}

export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  message: string;
  deliver: boolean;
  channel: string;
  to: string;
  deleteAfterRun: boolean;
  createdAt: string;
}

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface MinbotConfig {
  apiKey: string;
  apiBase?: string;
  model: string;
  workspace: string;
  maxIterations: number;
  memoryWindow: number;
  maxTokens: number;
  temperature: number;
  braveApiKey?: string;
  restrictToWorkspace?: boolean;
}
