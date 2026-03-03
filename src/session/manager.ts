/**
 * Session management — persists conversation history as JSONL files.
 *
 * File layout:
 *   {workspace}/sessions/{channel}_{chatId}.jsonl
 *
 * Each file starts with a metadata line (_type: "metadata"), followed by
 * one JSON object per message.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SessionMessage, SessionMetadata, ToolCallDict } from '../types/index.js';

export class Session {
  key: string;
  messages: SessionMessage[];
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  lastConsolidated: number;

  constructor(
    key: string,
    messages: SessionMessage[] = [],
    createdAt: Date = new Date(),
    updatedAt: Date = new Date(),
    metadata: Record<string, unknown> = {},
    lastConsolidated = 0,
  ) {
    this.key = key;
    this.messages = messages;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.metadata = metadata;
    this.lastConsolidated = lastConsolidated;
  }

  /**
   * Return unconsolidated messages for LLM input, aligned to a user turn.
   * Strips internal fields (timestamp, toolsUsed) for clean LLM messages.
   */
  getHistory(maxMessages = 500): SessionMessage[] {
    const unconsolidated = this.messages.slice(this.lastConsolidated);
    let sliced = unconsolidated.slice(-maxMessages);

    // Drop leading non-user messages to avoid orphaned tool_result blocks
    const firstUserIdx = sliced.findIndex((m) => m.role === 'user');
    if (firstUserIdx > 0) {
      sliced = sliced.slice(firstUserIdx);
    }

    return sliced.map((m) => {
      const entry: SessionMessage = { role: m.role, content: m.content ?? '' };
      if (m.toolCalls) entry.toolCalls = m.toolCalls;
      if (m.toolCallId) entry.toolCallId = m.toolCallId;
      if (m.name) entry.name = m.name;
      return entry;
    });
  }

  clear(): void {
    this.messages = [];
    this.lastConsolidated = 0;
    this.updatedAt = new Date();
  }
}

export class SessionManager {
  private readonly _sessionsDir: string;
  private readonly _cache = new Map<string, Session>();

  constructor(workspace: string) {
    this._sessionsDir = path.join(workspace, 'sessions');
    fs.mkdirSync(this._sessionsDir, { recursive: true });
  }

  private _sessionPath(key: string): string {
    const safeKey = key.replace(/[:/\\?*"|<>]/g, '_');
    return path.join(this._sessionsDir, `${safeKey}.jsonl`);
  }

  getOrCreate(key: string): Session {
    const cached = this._cache.get(key);
    if (cached) return cached;

    const loaded = this._load(key);
    const session = loaded ?? new Session(key);
    this._cache.set(key, session);
    return session;
  }

  private _load(key: string): Session | null {
    const filePath = this._sessionPath(key);
    if (!fs.existsSync(filePath)) return null;

    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      const messages: SessionMessage[] = [];
      let metadata: Record<string, unknown> = {};
      let createdAt = new Date();
      let lastConsolidated = 0;

      for (const line of lines) {
        const data = JSON.parse(line) as Record<string, unknown>;
        if (data['_type'] === 'metadata') {
          const meta = data as unknown as SessionMetadata;
          metadata = meta.metadata ?? {};
          createdAt = new Date(meta.createdAt);
          lastConsolidated = meta.lastConsolidated ?? 0;
        } else {
          messages.push(data as unknown as SessionMessage);
        }
      }

      return new Session(key, messages, createdAt, new Date(), metadata, lastConsolidated);
    } catch {
      console.warn(`[Session] Failed to load session ${key}, starting fresh`);
      return null;
    }
  }

  save(session: Session): void {
    session.updatedAt = new Date();
    const filePath = this._sessionPath(session.key);

    const meta: SessionMetadata = {
      _type: 'metadata',
      key: session.key,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      metadata: session.metadata,
      lastConsolidated: session.lastConsolidated,
    };

    const lines = [JSON.stringify(meta), ...session.messages.map((m) => JSON.stringify(m))];
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    this._cache.set(session.key, session);
  }

  invalidate(key: string): void {
    this._cache.delete(key);
  }

  list(): Array<{ key: string; createdAt: string; updatedAt: string }> {
    const results: Array<{ key: string; createdAt: string; updatedAt: string }> = [];

    for (const file of fs.readdirSync(this._sessionsDir)) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const firstLine = fs.readFileSync(path.join(this._sessionsDir, file), 'utf-8').split('\n')[0];
        if (!firstLine) continue;
        const data = JSON.parse(firstLine) as SessionMetadata;
        if (data._type === 'metadata') {
          results.push({ key: data.key, createdAt: data.createdAt, updatedAt: data.updatedAt });
        }
      } catch {
        // skip corrupt files
      }
    }

    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

/**
 * Add a new turn's messages to the session, truncating large tool results.
 */
export function saveTurn(
  session: Session,
  allMessages: SessionMessage[],
  skip: number,
  maxToolResultChars = 500,
): void {
  const now = new Date().toISOString();
  for (const m of allMessages.slice(skip)) {
    const entry: SessionMessage = { ...m };
    // Truncate large tool results to keep session files compact
    if (entry.role === 'tool' && typeof entry.content === 'string') {
      if (entry.content.length > maxToolResultChars) {
        entry.content = entry.content.slice(0, maxToolResultChars) + '\n... (truncated)';
      }
    }
    entry.timestamp = now;
    session.messages.push(entry);
  }
  session.updatedAt = new Date();
}

/**
 * Convert SessionMessage array to the ChatMessage format used by the LLM.
 * Filters out internal fields.
 */
export function toApiMessages(
  messages: SessionMessage[],
): Array<{
  role: string;
  content: string | null;
  toolCalls?: ToolCallDict[];
  toolCallId?: string;
  name?: string;
}> {
  return messages.map((m) => {
    const out: ReturnType<typeof toApiMessages>[0] = { role: m.role, content: m.content ?? null };
    if (m.toolCalls) out.toolCalls = m.toolCalls;
    if (m.toolCallId) out.toolCallId = m.toolCallId;
    if (m.name) out.name = m.name;
    return out;
  });
}
