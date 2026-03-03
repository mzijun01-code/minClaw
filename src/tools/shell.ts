/**
 * Shell execution tool — exec
 *
 * Runs shell commands with safety guards against dangerous patterns.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { Tool } from './base.js';
import type { JSONSchema } from '../types/index.js';

const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/i,
  /\bdel\s+\/[fq]\b/i,
  /\brmdir\s+\/s\b/i,
  /(?:^|[;&|]\s*)format\b/i,
  /\b(mkfs|diskpart)\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/,
  /\b(shutdown|reboot|poweroff)\b/i,
  /:\(\)\s*\{.*\};\s*:/,
];

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: -1 });
    }, timeoutMs);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8', 0, d.length); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8', 0, d.length); });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

export class ExecTool extends Tool {
  readonly name = 'exec';
  readonly description = 'Execute a shell command and return its output.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      working_dir: {
        type: 'string',
        description: 'Optional working directory for the command',
      },
    },
    required: ['command'],
  };

  private readonly _workingDir: string;
  private readonly _timeoutMs: number;
  private readonly _denyPatterns: RegExp[];
  private readonly _restrictToWorkspace: boolean;

  constructor(options: {
    workingDir?: string;
    timeoutSeconds?: number;
    denyPatterns?: RegExp[];
    restrictToWorkspace?: boolean;
  } = {}) {
    super();
    this._workingDir = options.workingDir ?? process.cwd();
    this._timeoutMs = (options.timeoutSeconds ?? 60) * 1000;
    this._denyPatterns = options.denyPatterns ?? DEFAULT_DENY_PATTERNS;
    this._restrictToWorkspace = options.restrictToWorkspace ?? false;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args['command'] as string;
    const cwd = (args['working_dir'] as string | undefined) ?? this._workingDir;

    const guardError = this._guard(command, cwd);
    if (guardError) return guardError;

    const { stdout, stderr, exitCode } = await runCommand(command, cwd, this._timeoutMs);

    if (exitCode === -1) {
      return `Error: Command timed out after ${this._timeoutMs / 1000} seconds`;
    }

    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr.trim()) parts.push(`STDERR:\n${stderr}`);
    if (exitCode !== 0) parts.push(`\nExit code: ${exitCode}`);

    let result = parts.length ? parts.join('\n') : '(no output)';

    const MAX_LEN = 10_000;
    if (result.length > MAX_LEN) {
      result = result.slice(0, MAX_LEN) + `\n... (truncated, ${result.length - MAX_LEN} more chars)`;
    }

    return result;
  }

  private _guard(command: string, cwd: string): string | null {
    const lower = command.toLowerCase();

    for (const pattern of this._denyPatterns) {
      if (pattern.test(lower)) {
        return 'Error: Command blocked by safety guard (dangerous pattern detected)';
      }
    }

    if (this._restrictToWorkspace) {
      if (command.includes('../') || command.includes('..\\')) {
        return 'Error: Command blocked by safety guard (path traversal detected)';
      }

      const cwdResolved = path.resolve(cwd);
      const absPathMatches = command.match(/(?:^|[\s|>])(\/[^\s"'>]+)/g) ?? [];

      for (const rawMatch of absPathMatches) {
        const raw = rawMatch.trim();
        try {
          const p = path.resolve(raw);
          if (
            path.isAbsolute(p) &&
            !p.startsWith(cwdResolved + path.sep) &&
            p !== cwdResolved
          ) {
            return 'Error: Command blocked by safety guard (path outside working dir)';
          }
        } catch {
          // ignore malformed paths
        }
      }
    }

    return null;
  }
}
