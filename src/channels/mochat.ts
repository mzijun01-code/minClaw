/**
 * MochatChannel — Socket.IO-based channel for WeChat bridging via MoChat/Tailchat.
 *
 * Supports:
 *  - Socket.IO WebSocket connection (primary)
 *  - HTTP long-polling fallback per session/panel
 *  - Session cursor persistence to disk (dedup & resume)
 *  - Delayed-reply buffering for group panels (batches non-mention messages)
 *  - Auto-discovery of sessions and panels via "*" wildcard config
 */

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { io as socketIoClient, type Socket } from 'socket.io-client';

import type { OutboundMessage } from '../types/index.js';
import type { MessageBus } from '../bus/queue.js';
import { BaseChannel } from './base.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MochatMentionConfig {
  require_in_groups: boolean;
}

export interface MochatGroupRule {
  require_mention: boolean;
}

export interface MochatConfig {
  allowFrom: string[];
  base_url: string;
  socket_url?: string;
  socket_path?: string;
  socket_disable_msgpack?: boolean;
  socket_reconnect_delay_ms?: number;
  socket_max_reconnect_delay_ms?: number;
  socket_connect_timeout_ms?: number;
  refresh_interval_ms?: number;
  watch_timeout_ms?: number;
  watch_limit?: number;
  retry_delay_ms?: number;
  max_retry_attempts?: number;
  claw_token: string;
  agent_user_id?: string;
  sessions?: string[];
  panels?: string[];
  mention?: MochatMentionConfig;
  groups?: Record<string, MochatGroupRule>;
  reply_delay_mode?: 'off' | 'non-mention';
  reply_delay_ms?: number;
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

interface BufferedEntry {
  rawBody: string;
  author: string;
  senderName: string;
  senderUsername: string;
  timestamp: number | null;
  messageId: string;
  groupId: string;
}

interface DelayState {
  entries: BufferedEntry[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface MochatTarget {
  id: string;
  isPanel: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function safeDict(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strField(src: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function resolveMochatTarget(raw: string): MochatTarget {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { id: '', isPanel: false };
  const lowered = trimmed.toLowerCase();
  let cleaned = trimmed;
  let forcedPanel = false;
  for (const prefix of ['mochat:', 'group:', 'channel:', 'panel:']) {
    if (lowered.startsWith(prefix)) {
      cleaned = trimmed.slice(prefix.length).trim();
      forcedPanel = prefix !== 'mochat:';
      break;
    }
  }
  if (!cleaned) return { id: '', isPanel: false };
  return { id: cleaned, isPanel: forcedPanel || !cleaned.startsWith('session_') };
}

function extractMentionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      ids.push(item.trim());
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      for (const key of ['id', 'userId', '_id']) {
        const candidate = obj[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          ids.push(candidate.trim());
          break;
        }
      }
    }
  }
  return ids;
}

function resolveWasMentioned(payload: Record<string, unknown>, agentUserId: string): boolean {
  const meta = safeDict(payload['meta']);
  if (meta['mentioned'] === true || meta['wasMentioned'] === true) return true;
  if (agentUserId) {
    for (const f of ['mentions', 'mentionIds', 'mentionedUserIds', 'mentionedUsers']) {
      if (extractMentionIds(meta[f]).includes(agentUserId)) return true;
    }
  }
  if (!agentUserId) return false;
  const content = payload['content'];
  if (typeof content !== 'string' || !content) return false;
  return content.includes(`<@${agentUserId}>`) || content.includes(`@${agentUserId}`);
}

function resolveRequireMention(
  config: MochatConfig,
  sessionId: string,
  groupId: string,
): boolean {
  const groups = config.groups ?? {};
  for (const key of [groupId, sessionId, '*']) {
    if (key && key in groups) return !!groups[key]!.require_mention;
  }
  return !!(config.mention?.require_in_groups);
}

function buildBufferedBody(entries: BufferedEntry[], isGroup: boolean): string {
  if (entries.length === 0) return '';
  if (entries.length === 1) return entries[0]!.rawBody;
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.rawBody) continue;
    if (isGroup) {
      const label = entry.senderName.trim() || entry.senderUsername.trim() || entry.author;
      if (label) { lines.push(`${label}: ${entry.rawBody}`); continue; }
    }
    lines.push(entry.rawBody);
  }
  return lines.join('\n').trim();
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return Math.floor(new Date(value).getTime());
  } catch {
    return null;
  }
}

function readGroupId(metadata: Record<string, unknown>): string | null {
  const v = metadata['group_id'] ?? metadata['groupId'];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// HTTP helper (native, no extra dep)
// ---------------------------------------------------------------------------

async function httpPostJson(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  timeoutMs = 30000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('HTTP timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SEEN_IDS = 2000;
const CURSOR_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class MochatChannel extends BaseChannel {
  readonly name = 'mochat';
  protected readonly config: MochatConfig;

  private _socket: Socket | null = null;
  private _wsConnected = false;
  private _wsReady = false;

  private _stateDir = '';
  private _cursorPath = '';
  private _sessionCursor: Record<string, number> = {};
  private _cursorDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private _sessionSet = new Set<string>();
  private _panelSet = new Set<string>();
  private _autoDiscoverSessions = false;
  private _autoDiscoverPanels = false;

  private _coldSessions = new Set<string>();
  private _sessionByConverse: Record<string, string> = {};

  private _seenSet: Record<string, Set<string>> = {};
  private _seenQueue: Record<string, string[]> = {};

  private _delayStates: Record<string, DelayState> = {};
  private _delayLocks: Record<string, Promise<void>> = {};

  private _fallbackMode = false;
  private _sessionFallbackAbort: Record<string, AbortController> = {};
  private _panelFallbackAbort: Record<string, AbortController> = {};
  private _refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _targetPromises: Record<string, Promise<void>> = {};

  constructor(config: MochatConfig, bus: MessageBus) {
    super(config, bus);
    this.config = config;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.config.claw_token) {
      console.error('[mochat] claw_token not configured');
      return;
    }

    this._running = true;

    const dataDir = process.env['NANOBOT_DATA_DIR']
      ?? nodePath.join(process.env['HOME'] ?? '/tmp', '.local', 'share', 'nanobot');
    this._stateDir = nodePath.join(dataDir, 'mochat');
    this._cursorPath = nodePath.join(this._stateDir, 'session_cursors.json');

    await fs.mkdir(this._stateDir, { recursive: true });
    await this._loadSessionCursors();
    this._seedTargetsFromConfig();
    await this._refreshTargets(false);

    const socketOk = await this._startSocketClient();
    if (!socketOk) await this._ensureFallbackWorkers();

    const intervalMs = Math.max(1000, this.config.refresh_interval_ms ?? 30000);
    this._refreshTimer = setInterval(async () => {
      if (!this._running) return;
      try {
        await this._refreshTargets(this._wsReady);
      } catch (e) {
        console.warn('[mochat] refresh error:', e);
      }
      if (this._fallbackMode) await this._ensureFallbackWorkers();
    }, intervalMs);

    // Block until stopped
    await new Promise<void>((resolve) => {
      const check = setInterval(() => { if (!this._running) { clearInterval(check); resolve(); } }, 500);
    });
  }

  async stop(): Promise<void> {
    this._running = false;

    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
    await this._stopFallbackWorkers();
    this._cancelAllDelayTimers();

    if (this._socket) {
      try { this._socket.disconnect(); } catch { /* ignore */ }
      this._socket = null;
    }
    if (this._cursorDebounceTimer) { clearTimeout(this._cursorDebounceTimer); this._cursorDebounceTimer = null; }
    await this._saveSessionCursors();
    this._wsConnected = this._wsReady = false;
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.config.claw_token) {
      console.warn('[mochat] claw_token missing, skip send');
      return;
    }
    const parts: string[] = [];
    if (msg.content?.trim()) parts.push(msg.content.trim());
    if (Array.isArray(msg.media)) {
      for (const m of msg.media) {
        if (typeof m === 'string' && m.trim()) parts.push(m.trim());
      }
    }
    const content = parts.join('\n').trim();
    if (!content) return;

    const target = resolveMochatTarget(msg.chatId);
    if (!target.id) { console.warn('[mochat] outbound target is empty'); return; }

    const isPanel = (target.isPanel || this._panelSet.has(target.id)) && !target.id.startsWith('session_');
    try {
      if (isPanel) {
        await this._apiSend('/api/claw/groups/panels/send', 'panelId', target.id,
          content, msg.replyTo ?? null, readGroupId(msg.metadata ?? {}));
      } else {
        await this._apiSend('/api/claw/sessions/send', 'sessionId', target.id,
          content, msg.replyTo ?? null, null);
      }
    } catch (e) {
      console.error('[mochat] Failed to send message:', e);
    }
  }

  // ── config / seeding ──────────────────────────────────────────────────────

  private _seedTargetsFromConfig(): void {
    const [sessions, autoSessions] = this._normalizeIdList(this.config.sessions ?? []);
    const [panels, autoPanels] = this._normalizeIdList(this.config.panels ?? []);
    this._autoDiscoverSessions = autoSessions;
    this._autoDiscoverPanels = autoPanels;
    for (const s of sessions) {
      this._sessionSet.add(s);
      if (!(s in this._sessionCursor)) this._coldSessions.add(s);
    }
    for (const p of panels) this._panelSet.add(p);
  }

  private _normalizeIdList(values: string[]): [string[], boolean] {
    const cleaned = values.map((v) => String(v).trim()).filter(Boolean);
    const withoutStar = [...new Set(cleaned.filter((v) => v !== '*'))].sort();
    return [withoutStar, cleaned.includes('*')];
  }

  // ── Socket.IO ─────────────────────────────────────────────────────────────

  private async _startSocketClient(): Promise<boolean> {
    const socketUrl = (this.config.socket_url || this.config.base_url).trim().replace(/\/$/, '');
    const socketPath = '/' + (this.config.socket_path ?? '/socket.io').trim().replace(/^\//, '');
    const reconnectDelay = Math.max(100, this.config.socket_reconnect_delay_ms ?? 1000) / 1000;
    const maxReconnectDelay = Math.max(100, this.config.socket_max_reconnect_delay_ms ?? 10000) / 1000;
    const connectTimeout = Math.max(1000, this.config.socket_connect_timeout_ms ?? 10000);

    const socket = socketIoClient(socketUrl, {
      path: socketPath,
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: this.config.max_retry_attempts || Infinity,
      reconnectionDelay: reconnectDelay * 1000,
      reconnectionDelayMax: maxReconnectDelay * 1000,
      auth: { token: this.config.claw_token },
      timeout: connectTimeout,
    });

    socket.on('connect', async () => {
      this._wsConnected = true;
      this._wsReady = false;
      console.log('[mochat] WebSocket connected');
      const subscribed = await this._subscribeAll(socket);
      this._wsReady = subscribed;
      if (subscribed) {
        await this._stopFallbackWorkers();
      } else {
        await this._ensureFallbackWorkers();
      }
    });

    socket.on('disconnect', async () => {
      if (!this._running) return;
      this._wsConnected = false;
      this._wsReady = false;
      console.warn('[mochat] WebSocket disconnected');
      await this._ensureFallbackWorkers();
    });

    socket.on('connect_error', (err) => {
      console.error('[mochat] WebSocket connect error:', err.message);
    });

    socket.on('claw.session.events', (payload: unknown) => {
      void this._handleWatchPayload(safeDict(payload), 'session');
    });
    socket.on('claw.panel.events', (payload: unknown) => {
      void this._handleWatchPayload(safeDict(payload), 'panel');
    });

    for (const ev of [
      'notify:chat.inbox.append',
      'notify:chat.message.add',
      'notify:chat.message.update',
      'notify:chat.message.recall',
      'notify:chat.message.delete',
    ]) {
      socket.on(ev, (payload: unknown) => {
        if (ev === 'notify:chat.inbox.append') {
          void this._handleNotifyInboxAppend(payload);
        } else {
          void this._handleNotifyChatMessage(payload);
        }
      });
    }

    this._socket = socket;

    // Wait for connect or timeout
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this._wsConnected) {
          console.error('[mochat] Socket connect timed out, switching to fallback');
          resolve(false);
        }
      }, connectTimeout + 2000);
      socket.once('connect', () => { clearTimeout(timer); resolve(true); });
      socket.once('connect_error', () => { clearTimeout(timer); resolve(false); });
    });
  }

  private _socketCall(socket: Socket, event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ result: false, message: 'timeout' }), 10000);
      socket.emit(event, payload, (ack: unknown) => {
        clearTimeout(timer);
        if (ack && typeof ack === 'object' && !Array.isArray(ack)) {
          resolve(ack as Record<string, unknown>);
        } else {
          resolve({ result: true, data: ack });
        }
      });
    });
  }

  // ── subscribe ─────────────────────────────────────────────────────────────

  private async _subscribeAll(socket: Socket): Promise<boolean> {
    let ok = await this._subscribeSessions(socket, [...this._sessionSet].sort());
    ok = (await this._subscribePanels(socket, [...this._panelSet].sort())) && ok;
    if (this._autoDiscoverSessions || this._autoDiscoverPanels) {
      await this._refreshTargets(true, socket);
    }
    return ok;
  }

  private async _subscribeSessions(socket: Socket, sessionIds: string[]): Promise<boolean> {
    if (sessionIds.length === 0) return true;
    for (const sid of sessionIds) {
      if (!(sid in this._sessionCursor)) this._coldSessions.add(sid);
    }
    const ack = await this._socketCall(socket, 'com.claw.im.subscribeSessions', {
      sessionIds,
      cursors: this._sessionCursor,
      limit: this.config.watch_limit ?? 100,
    });
    if (!ack['result']) {
      console.error('[mochat] subscribeSessions failed:', ack['message'] ?? 'unknown');
      return false;
    }
    const data = ack['data'];
    let items: Record<string, unknown>[] = [];
    if (Array.isArray(data)) {
      items = data.filter((i) => i && typeof i === 'object') as Record<string, unknown>[];
    } else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const sessions = d['sessions'];
      if (Array.isArray(sessions)) {
        items = sessions.filter((i) => i && typeof i === 'object') as Record<string, unknown>[];
      } else if ('sessionId' in d) {
        items = [d];
      }
    }
    for (const p of items) await this._handleWatchPayload(p, 'session');
    return true;
  }

  private async _subscribePanels(socket: Socket, panelIds: string[]): Promise<boolean> {
    if (!this._autoDiscoverPanels && panelIds.length === 0) return true;
    const ack = await this._socketCall(socket, 'com.claw.im.subscribePanels', { panelIds });
    if (!ack['result']) {
      console.error('[mochat] subscribePanels failed:', ack['message'] ?? 'unknown');
      return false;
    }
    return true;
  }

  // ── refresh / discovery ───────────────────────────────────────────────────

  private async _refreshTargets(subscribeNew: boolean, socket?: Socket): Promise<void> {
    if (this._autoDiscoverSessions) await this._refreshSessionsDirectory(subscribeNew, socket);
    if (this._autoDiscoverPanels) await this._refreshPanels(subscribeNew, socket);
  }

  private async _refreshSessionsDirectory(subscribeNew: boolean, socket?: Socket): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = await this._postJson('/api/claw/sessions/list', {});
    } catch (e) {
      console.warn('[mochat] listSessions failed:', e);
      return;
    }
    const sessions = response['sessions'];
    if (!Array.isArray(sessions)) return;

    const newIds: string[] = [];
    for (const s of sessions) {
      if (!s || typeof s !== 'object') continue;
      const obj = s as Record<string, unknown>;
      const sid = strField(obj, 'sessionId');
      if (!sid) continue;
      if (!this._sessionSet.has(sid)) {
        this._sessionSet.add(sid);
        newIds.push(sid);
        if (!(sid in this._sessionCursor)) this._coldSessions.add(sid);
      }
      const cid = strField(obj, 'converseId');
      if (cid) this._sessionByConverse[cid] = sid;
    }
    if (newIds.length === 0) return;
    if (this._wsReady && subscribeNew && socket) await this._subscribeSessions(socket, newIds);
    if (this._fallbackMode) await this._ensureFallbackWorkers();
  }

  private async _refreshPanels(subscribeNew: boolean, socket?: Socket): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = await this._postJson('/api/claw/groups/get', {});
    } catch (e) {
      console.warn('[mochat] getWorkspaceGroup failed:', e);
      return;
    }
    const rawPanels = response['panels'];
    if (!Array.isArray(rawPanels)) return;

    const newIds: string[] = [];
    for (const p of rawPanels) {
      if (!p || typeof p !== 'object') continue;
      const obj = p as Record<string, unknown>;
      const pt = obj['type'];
      if (typeof pt === 'number' && pt !== 0) continue;
      const pid = strField(obj, 'id', '_id');
      if (pid && !this._panelSet.has(pid)) {
        this._panelSet.add(pid);
        newIds.push(pid);
      }
    }
    if (newIds.length === 0) return;
    if (this._wsReady && subscribeNew && socket) await this._subscribePanels(socket, newIds);
    if (this._fallbackMode) await this._ensureFallbackWorkers();
  }

  // ── fallback polling workers ───────────────────────────────────────────────

  private async _ensureFallbackWorkers(): Promise<void> {
    if (!this._running) return;
    this._fallbackMode = true;
    for (const sid of [...this._sessionSet].sort()) {
      if (!this._sessionFallbackAbort[sid] || !this._isWorkerRunning(this._sessionFallbackAbort[sid]!)) {
        const ac = new AbortController();
        this._sessionFallbackAbort[sid] = ac;
        void this._sessionWatchWorker(sid, ac.signal);
      }
    }
    for (const pid of [...this._panelSet].sort()) {
      if (!this._panelFallbackAbort[pid] || !this._isWorkerRunning(this._panelFallbackAbort[pid]!)) {
        const ac = new AbortController();
        this._panelFallbackAbort[pid] = ac;
        void this._panelPollWorker(pid, ac.signal);
      }
    }
  }

  private _isWorkerRunning(ac: AbortController): boolean {
    return !ac.signal.aborted;
  }

  private async _stopFallbackWorkers(): Promise<void> {
    this._fallbackMode = false;
    for (const ac of Object.values(this._sessionFallbackAbort)) ac.abort();
    for (const ac of Object.values(this._panelFallbackAbort)) ac.abort();
    this._sessionFallbackAbort = {};
    this._panelFallbackAbort = {};
  }

  private async _sessionWatchWorker(sessionId: string, signal: AbortSignal): Promise<void> {
    const retryDelayMs = Math.max(100, this.config.retry_delay_ms ?? 500);
    while (this._running && this._fallbackMode && !signal.aborted) {
      try {
        const payload = await this._postJson('/api/claw/sessions/watch', {
          sessionId,
          cursor: this._sessionCursor[sessionId] ?? 0,
          timeoutMs: this.config.watch_timeout_ms ?? 25000,
          limit: this.config.watch_limit ?? 100,
        });
        if (!signal.aborted) await this._handleWatchPayload(payload, 'session');
      } catch (e) {
        if (signal.aborted) break;
        console.warn(`[mochat] watch fallback error (${sessionId}):`, e);
        await this._sleep(retryDelayMs, signal);
      }
    }
  }

  private async _panelPollWorker(panelId: string, signal: AbortSignal): Promise<void> {
    const sleepMs = Math.max(1000, this.config.refresh_interval_ms ?? 30000);
    const limit = Math.min(100, Math.max(1, this.config.watch_limit ?? 100));
    while (this._running && this._fallbackMode && !signal.aborted) {
      try {
        const resp = await this._postJson('/api/claw/groups/panels/messages', { panelId, limit });
        const msgs = resp['messages'];
        if (Array.isArray(msgs)) {
          for (const m of [...msgs].reverse()) {
            if (!m || typeof m !== 'object') continue;
            const obj = m as Record<string, unknown>;
            const evt = this._makeSyntheticEvent(
              String(obj['messageId'] ?? ''),
              String(obj['author'] ?? ''),
              obj['content'],
              obj['meta'],
              String(resp['groupId'] ?? ''),
              panelId,
              obj['createdAt'],
              obj['authorInfo'],
            );
            if (!signal.aborted) await this._processInboundEvent(panelId, evt, 'panel');
          }
        }
      } catch (e) {
        if (signal.aborted) break;
        console.warn(`[mochat] panel polling error (${panelId}):`, e);
      }
      await this._sleep(sleepMs, signal);
    }
  }

  private _sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  // ── inbound processing ────────────────────────────────────────────────────

  private async _handleWatchPayload(payload: Record<string, unknown>, targetKind: string): Promise<void> {
    const targetId = strField(payload, 'sessionId');
    if (!targetId) return;

    const lockKey = `${targetKind}:${targetId}`;
    const prev = (this._targetPromises[lockKey] ?? Promise.resolve());
    let resolve!: () => void;
    this._targetPromises[lockKey] = new Promise<void>((r) => { resolve = r; });

    await prev;
    try {
      const prevCursor = this._sessionCursor[targetId] ?? 0;
      const pc = payload['cursor'];
      if (targetKind === 'session' && typeof pc === 'number' && pc >= 0) {
        this._markSessionCursor(targetId, pc);
      }

      const rawEvents = payload['events'];
      if (!Array.isArray(rawEvents)) return;
      if (targetKind === 'session' && this._coldSessions.has(targetId)) {
        this._coldSessions.delete(targetId);
        return;
      }

      for (const event of rawEvents) {
        if (!event || typeof event !== 'object') continue;
        const evt = event as Record<string, unknown>;
        const seq = evt['seq'];
        if (targetKind === 'session' && typeof seq === 'number' && seq > (this._sessionCursor[targetId] ?? prevCursor)) {
          this._markSessionCursor(targetId, seq);
        }
        if (evt['type'] === 'message.add') {
          await this._processInboundEvent(targetId, evt, targetKind);
        }
      }
    } finally {
      resolve();
    }
  }

  private async _processInboundEvent(
    targetId: string,
    event: Record<string, unknown>,
    targetKind: string,
  ): Promise<void> {
    const payload = safeDict(event['payload']);
    const author = strField(payload, 'author');
    if (!author) return;
    if (this.config.agent_user_id && author === this.config.agent_user_id) return;
    if (!this.isAllowed(author)) return;

    const messageId = strField(payload, 'messageId');
    const seenKey = `${targetKind}:${targetId}`;
    if (messageId && this._rememberMessageId(seenKey, messageId)) return;

    const rawBody = normalizeContent(payload['content']) || '[empty message]';
    const ai = safeDict(payload['authorInfo']);
    const senderName = strField(ai, 'nickname', 'email');
    const senderUsername = strField(ai, 'agentId');
    const groupId = strField(payload, 'groupId');
    const isGroup = !!groupId;
    const wasMentioned = resolveWasMentioned(payload, this.config.agent_user_id ?? '');
    const requireMention =
      targetKind === 'panel' && isGroup && resolveRequireMention(this.config, targetId, groupId);
    const replyDelayMode = this.config.reply_delay_mode ?? 'non-mention';
    const useDelay = targetKind === 'panel' && replyDelayMode === 'non-mention';

    if (requireMention && !wasMentioned && !useDelay) return;

    const entry: BufferedEntry = {
      rawBody, author, senderName, senderUsername,
      timestamp: parseTimestamp(event['timestamp']),
      messageId, groupId,
    };

    if (useDelay) {
      const delayKey = seenKey;
      if (wasMentioned) {
        await this._flushDelayedEntries(delayKey, targetId, targetKind, 'mention', entry);
      } else {
        this._enqueueDelayedEntry(delayKey, targetId, targetKind, entry);
      }
      return;
    }
    await this._dispatchEntries(targetId, targetKind, [entry], wasMentioned);
  }

  // ── dedup / buffering ─────────────────────────────────────────────────────

  private _rememberMessageId(key: string, messageId: string): boolean {
    if (!this._seenSet[key]) { this._seenSet[key] = new Set(); this._seenQueue[key] = []; }
    const set = this._seenSet[key]!;
    const queue = this._seenQueue[key]!;
    if (set.has(messageId)) return true;
    set.add(messageId);
    queue.push(messageId);
    while (queue.length > MAX_SEEN_IDS) { set.delete(queue.shift()!); }
    return false;
  }

  private _enqueueDelayedEntry(key: string, targetId: string, targetKind: string, entry: BufferedEntry): void {
    if (!this._delayStates[key]) this._delayStates[key] = { entries: [], timer: null };
    const state = this._delayStates[key]!;
    state.entries.push(entry);
    if (state.timer) clearTimeout(state.timer);
    const delayMs = Math.max(0, this.config.reply_delay_ms ?? 120000);
    state.timer = setTimeout(() => {
      void this._flushDelayedEntries(key, targetId, targetKind, 'timer', null);
    }, delayMs);
  }

  private async _flushDelayedEntries(
    key: string, targetId: string, targetKind: string, _reason: string, entry: BufferedEntry | null,
  ): Promise<void> {
    if (!this._delayStates[key]) this._delayStates[key] = { entries: [], timer: null };
    const state = this._delayStates[key]!;
    if (entry) state.entries.push(entry);
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    const entries = state.entries.splice(0);
    if (entries.length > 0) {
      await this._dispatchEntries(targetId, targetKind, entries, _reason === 'mention');
    }
  }

  private async _dispatchEntries(
    targetId: string, targetKind: string, entries: BufferedEntry[], wasMentioned: boolean,
  ): Promise<void> {
    if (entries.length === 0) return;
    const last = entries[entries.length - 1]!;
    const isGroup = !!last.groupId;
    const body = buildBufferedBody(entries, isGroup) || '[empty message]';
    await this._handleMessage({
      senderId: last.author,
      chatId: targetId,
      content: body,
      metadata: {
        message_id: last.messageId,
        timestamp: last.timestamp,
        is_group: isGroup,
        group_id: last.groupId,
        sender_name: last.senderName,
        sender_username: last.senderUsername,
        target_kind: targetKind,
        was_mentioned: wasMentioned,
        buffered_count: entries.length,
      },
    });
  }

  private _cancelAllDelayTimers(): void {
    for (const state of Object.values(this._delayStates)) {
      if (state.timer) clearTimeout(state.timer);
    }
    this._delayStates = {};
  }

  // ── notify handlers ───────────────────────────────────────────────────────

  private async _handleNotifyChatMessage(rawPayload: unknown): Promise<void> {
    if (!rawPayload || typeof rawPayload !== 'object') return;
    const payload = rawPayload as Record<string, unknown>;
    const groupId = strField(payload, 'groupId');
    const panelId = strField(payload, 'converseId', 'panelId');
    if (!groupId || !panelId) return;
    if (this._panelSet.size > 0 && !this._panelSet.has(panelId)) return;

    const evt = this._makeSyntheticEvent(
      String(payload['_id'] ?? payload['messageId'] ?? ''),
      String(payload['author'] ?? ''),
      payload['content'], payload['meta'],
      groupId, panelId, payload['createdAt'], payload['authorInfo'],
    );
    await this._processInboundEvent(panelId, evt, 'panel');
  }

  private async _handleNotifyInboxAppend(rawPayload: unknown): Promise<void> {
    if (!rawPayload || typeof rawPayload !== 'object') return;
    const payload = rawPayload as Record<string, unknown>;
    if (payload['type'] !== 'message') return;
    const detail = safeDict(payload['payload']);
    if (strField(detail, 'groupId')) return;
    const converseId = strField(detail, 'converseId');
    if (!converseId) return;

    let sessionId = this._sessionByConverse[converseId];
    if (!sessionId) {
      await this._refreshSessionsDirectory(this._wsReady);
      sessionId = this._sessionByConverse[converseId];
    }
    if (!sessionId) return;

    const evt = this._makeSyntheticEvent(
      String(detail['messageId'] ?? payload['_id'] ?? ''),
      String(detail['messageAuthor'] ?? ''),
      String(detail['messagePlainContent'] ?? detail['messageSnippet'] ?? ''),
      { source: 'notify:chat.inbox.append', converseId },
      '', converseId, payload['createdAt'], undefined,
    );
    await this._processInboundEvent(sessionId, evt, 'session');
  }

  private _makeSyntheticEvent(
    messageId: string, author: string, content: unknown,
    meta: unknown, groupId: string, converseId: string,
    timestamp?: unknown, authorInfo?: unknown,
  ): Record<string, unknown> {
    const p: Record<string, unknown> = {
      messageId, author, content, meta: safeDict(meta), groupId, converseId,
    };
    if (authorInfo !== undefined) p['authorInfo'] = safeDict(authorInfo);
    return {
      type: 'message.add',
      timestamp: typeof timestamp === 'string' ? timestamp : new Date().toISOString(),
      payload: p,
    };
  }

  // ── cursor persistence ────────────────────────────────────────────────────

  private _markSessionCursor(sessionId: string, cursor: number): void {
    if (cursor < 0 || cursor < (this._sessionCursor[sessionId] ?? 0)) return;
    this._sessionCursor[sessionId] = cursor;
    if (this._cursorDebounceTimer) clearTimeout(this._cursorDebounceTimer);
    this._cursorDebounceTimer = setTimeout(() => void this._saveSessionCursors(), CURSOR_DEBOUNCE_MS);
  }

  private async _loadSessionCursors(): Promise<void> {
    try {
      const raw = await fs.readFile(this._cursorPath, 'utf8');
      const data = JSON.parse(raw) as unknown;
      if (data && typeof data === 'object') {
        const cursors = (data as Record<string, unknown>)['cursors'];
        if (cursors && typeof cursors === 'object') {
          for (const [sid, cur] of Object.entries(cursors as Record<string, unknown>)) {
            if (typeof cur === 'number' && cur >= 0) this._sessionCursor[sid] = cur;
          }
        }
      }
    } catch { /* file may not exist */ }
  }

  private async _saveSessionCursors(): Promise<void> {
    try {
      await fs.mkdir(this._stateDir, { recursive: true });
      await fs.writeFile(this._cursorPath, JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        cursors: this._sessionCursor,
      }, null, 2) + '\n', 'utf8');
    } catch (e) {
      console.warn('[mochat] Failed to save cursor file:', e);
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async _postJson(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const url = `${this.config.base_url.trim().replace(/\/$/, '')}${path}`;
    const raw = await httpPostJson(url, payload, { 'X-Claw-Token': this.config.claw_token });
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (typeof obj['code'] === 'number' && obj['code'] !== 200) {
        const msg = String(obj['message'] ?? obj['name'] ?? 'request failed');
        throw new Error(`Mochat API error: ${msg} (code=${obj['code']})`);
      }
      const data = obj['data'];
      return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : obj;
    }
    return {};
  }

  private async _apiSend(
    path: string, idKey: string, idVal: string,
    content: string, replyTo: string | null, groupId: string | null,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { [idKey]: idVal, content };
    if (replyTo) body['replyTo'] = replyTo;
    if (groupId) body['groupId'] = groupId;
    return this._postJson(path, body);
  }
}

// ---------------------------------------------------------------------------
// Factory helper — build config from env vars
// ---------------------------------------------------------------------------

export function mochatConfigFromEnv(allowFrom: string[]): MochatConfig {
  const parseList = (raw: string | undefined): string[] =>
    (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    allowFrom,
    base_url: process.env['MOCHAT_BASE_URL'] ?? 'https://mochat.io',
    socket_url: process.env['MOCHAT_SOCKET_URL'] ?? '',
    socket_path: process.env['MOCHAT_SOCKET_PATH'] ?? '/socket.io',
    socket_reconnect_delay_ms: Number(process.env['MOCHAT_RECONNECT_DELAY_MS'] ?? 1000),
    socket_max_reconnect_delay_ms: Number(process.env['MOCHAT_MAX_RECONNECT_DELAY_MS'] ?? 10000),
    socket_connect_timeout_ms: Number(process.env['MOCHAT_CONNECT_TIMEOUT_MS'] ?? 10000),
    refresh_interval_ms: Number(process.env['MOCHAT_REFRESH_INTERVAL_MS'] ?? 30000),
    watch_timeout_ms: Number(process.env['MOCHAT_WATCH_TIMEOUT_MS'] ?? 25000),
    watch_limit: Number(process.env['MOCHAT_WATCH_LIMIT'] ?? 100),
    retry_delay_ms: Number(process.env['MOCHAT_RETRY_DELAY_MS'] ?? 500),
    max_retry_attempts: Number(process.env['MOCHAT_MAX_RETRY_ATTEMPTS'] ?? 0),
    claw_token: process.env['MOCHAT_CLAW_TOKEN'] ?? '',
    agent_user_id: process.env['MOCHAT_AGENT_USER_ID'] ?? '',
    sessions: parseList(process.env['MOCHAT_SESSIONS']),
    panels: parseList(process.env['MOCHAT_PANELS']),
    reply_delay_mode: (process.env['MOCHAT_REPLY_DELAY_MODE'] ?? 'non-mention') as 'off' | 'non-mention',
    reply_delay_ms: Number(process.env['MOCHAT_REPLY_DELAY_MS'] ?? 120000),
  };
}
