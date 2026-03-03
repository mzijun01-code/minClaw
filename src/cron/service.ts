/**
 * CronService — manages scheduled jobs.
 *
 * Supports three schedule types:
 *   every  — fixed interval (setInterval)
 *   cron   — cron expression via node-cron
 *   at     — one-time future execution (setTimeout)
 *
 * Jobs are persisted to {workspace}/cron/jobs.json and restored on startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import nodeCron from 'node-cron';
import type { CronJob, CronSchedule } from '../types/index.js';

type JobCallback = (job: CronJob) => void;

interface ActiveJob {
  job: CronJob;
  stop: () => void;
}

export class CronService {
  private readonly _jobsFile: string;
  private readonly _active = new Map<string, ActiveJob>();
  private _onFire?: JobCallback;

  constructor(workspace: string) {
    const cronDir = path.join(workspace, 'cron');
    fs.mkdirSync(cronDir, { recursive: true });
    this._jobsFile = path.join(cronDir, 'jobs.json');
  }

  onFire(callback: JobCallback): void {
    this._onFire = callback;
  }

  start(): void {
    const saved = this._loadJobs();
    for (const job of saved) {
      this._schedule(job);
    }
    console.log(`[Cron] Started with ${saved.length} persisted jobs`);
  }

  stop(): void {
    for (const { stop } of this._active.values()) {
      stop();
    }
    this._active.clear();
  }

  addJob(params: {
    name: string;
    schedule: CronSchedule;
    message: string;
    deliver?: boolean;
    channel?: string;
    to?: string;
    deleteAfterRun?: boolean;
  }): CronJob {
    const job: CronJob = {
      id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: params.name,
      schedule: params.schedule,
      message: params.message,
      deliver: params.deliver ?? false,
      channel: params.channel ?? '',
      to: params.to ?? '',
      deleteAfterRun: params.deleteAfterRun ?? false,
      createdAt: new Date().toISOString(),
    };

    this._schedule(job);
    this._persistJobs();
    return job;
  }

  removeJob(id: string): boolean {
    const active = this._active.get(id);
    if (!active) return false;
    active.stop();
    this._active.delete(id);
    this._persistJobs();
    return true;
  }

  listJobs(): CronJob[] {
    return Array.from(this._active.values()).map((a) => a.job);
  }

  private _schedule(job: CronJob): void {
    const { schedule } = job;
    let stop: () => void;

    if (schedule.kind === 'every' && schedule.everyMs) {
      const handle = setInterval(() => this._fire(job), schedule.everyMs);
      stop = () => clearInterval(handle);
    } else if (schedule.kind === 'cron' && schedule.expr) {
      const task = nodeCron.schedule(schedule.expr, () => this._fire(job), {
        timezone: schedule.tz,
      });
      stop = () => task.stop();
    } else if (schedule.kind === 'at' && schedule.atMs) {
      const delay = schedule.atMs - Date.now();
      if (delay < 0) {
        // Already past — skip
        console.warn(`[Cron] Job "${job.name}" scheduled in the past, skipping`);
        return;
      }
      const handle = setTimeout(() => {
        this._fire(job);
        if (job.deleteAfterRun) this.removeJob(job.id);
      }, delay);
      stop = () => clearTimeout(handle);
    } else {
      console.warn(`[Cron] Unknown schedule kind for job "${job.name}"`);
      return;
    }

    this._active.set(job.id, { job, stop });
  }

  private _fire(job: CronJob): void {
    console.log(`[Cron] Firing job "${job.name}" (${job.id})`);
    this._onFire?.(job);
  }

  private _persistJobs(): void {
    const jobs = Array.from(this._active.values()).map((a) => a.job);
    fs.writeFileSync(this._jobsFile, JSON.stringify(jobs, null, 2), 'utf-8');
  }

  private _loadJobs(): CronJob[] {
    if (!fs.existsSync(this._jobsFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(this._jobsFile, 'utf-8')) as CronJob[];
    } catch {
      return [];
    }
  }
}
