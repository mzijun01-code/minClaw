/**
 * 定时任务工具：管理提醒与周期任务。动作：add（新增）、list（列表）、remove（删除）。
 * 支持按间隔秒数、cron 表达式、或单次执行时间（at）调度。
 */

import { Tool } from './base.js';
import type { JSONSchema, CronSchedule } from '../../types/index.js';
import type { CronService } from '../../cron/service.js';

export class CronTool extends Tool {
  readonly name = 'cron';
  readonly description = 'Schedule reminders and recurring tasks. Actions: add, list, remove.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'list', 'remove'],
        description: 'Action to perform',
      },
      message: { type: 'string', description: 'Reminder message (for add)' },
      every_seconds: {
        type: 'integer',
        description: 'Interval in seconds for recurring tasks',
      },
      cron_expr: {
        type: 'string',
        description: "Cron expression like '0 9 * * *'",
      },
      tz: {
        type: 'string',
        description: "IANA timezone (e.g. 'America/New_York')",
      },
      at: {
        type: 'string',
        description: "ISO datetime for one-time execution (e.g. '2026-03-01T10:30:00')",
      },
      job_id: { type: 'string', description: 'Job ID (for remove)' },
    },
    required: ['action'],
  };

  private _channel = '';
  private _chatId = '';
  private _inCronContext = false;

  constructor(private readonly _service: CronService) {
    super();
  }

  setContext(channel: string, chatId: string): void {
    this._channel = channel;
    this._chatId = chatId;
  }

  /** 标记当前在 cron 回调中执行，禁止在回调内再次添加任务。 */
  enterCronContext(): void {
    this._inCronContext = true;
  }

  leaveCronContext(): void {
    this._inCronContext = false;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args['action'] as string;

    switch (action) {
      case 'add': return this._add(args);
      case 'list': return this._list();
      case 'remove': return this._remove(args['job_id'] as string | undefined);
      default: return `Unknown action: ${action}`;
    }
  }

  /** 新增任务：every_seconds / cron_expr / at 三选一，单次任务用 at 且 deleteAfterRun。 */
  private _add(args: Record<string, unknown>): string {
    if (this._inCronContext) {
      return 'Error: cannot schedule new jobs from within a cron job execution';
    }
    const message = args['message'] as string | undefined;
    if (!message) return 'Error: message is required for add';
    if (!this._channel || !this._chatId) return 'Error: no session context (channel/chatId)';

    const everySeconds = args['every_seconds'] as number | undefined;
    const cronExpr = args['cron_expr'] as string | undefined;
    const tz = args['tz'] as string | undefined;
    const at = args['at'] as string | undefined;

    if (tz && !cronExpr) return 'Error: tz can only be used with cron_expr';

    let schedule: CronSchedule;
    let deleteAfterRun = false;

    if (everySeconds) {
      schedule = { kind: 'every', everyMs: everySeconds * 1000 };
    } else if (cronExpr) {
      schedule = { kind: 'cron', expr: cronExpr, tz };
    } else if (at) {
      const dt = new Date(at);
      if (isNaN(dt.getTime())) return `Error: Invalid datetime: ${at}`;
      schedule = { kind: 'at', atMs: dt.getTime() };
      deleteAfterRun = true;
    } else {
      return 'Error: one of every_seconds, cron_expr, or at is required';
    }

    const job = this._service.addJob({
      name: message.slice(0, 30),
      schedule,
      message,
      deliver: true,
      channel: this._channel,
      to: this._chatId,
      deleteAfterRun,
    });

    return `Created job '${job.name}' (id: ${job.id})`;
  }

  private _list(): string {
    const jobs = this._service.listJobs();
    if (!jobs.length) return 'No scheduled jobs.';
    return (
      'Scheduled jobs:\n' +
      jobs.map((j) => `- ${j.name} (id: ${j.id}, ${j.schedule.kind})`).join('\n')
    );
  }

  private _remove(jobId?: string): string {
    if (!jobId) return 'Error: job_id is required for remove';
    return this._service.removeJob(jobId) ? `Removed job ${jobId}` : `Job ${jobId} not found`;
  }
}
