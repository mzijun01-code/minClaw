/**
 * Spawn tool — starts a background subagent to handle a task.
 */

import { Tool } from './base.js';
import type { JSONSchema } from '../types/index.js';
import type { SubagentManager } from '../agent/subagent.js';

export class SpawnTool extends Tool {
  readonly name = 'spawn';
  readonly description =
    'Spawn a subagent to handle a task in the background. ' +
    'Use this for complex or time-consuming tasks that can run independently. ' +
    'The subagent will complete the task and report back when done.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task for the subagent to complete' },
      label: {
        type: 'string',
        description: 'Optional short label for the task (for display)',
      },
    },
    required: ['task'],
  };

  private _originChannel = 'cli';
  private _originChatId = 'direct';

  constructor(private readonly _manager: SubagentManager) {
    super();
  }

  setContext(channel: string, chatId: string): void {
    this._originChannel = channel;
    this._originChatId = chatId;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return this._manager.spawn({
      task: args['task'] as string,
      label: args['label'] as string | undefined,
      originChannel: this._originChannel,
      originChatId: this._originChatId,
    });
  }
}
