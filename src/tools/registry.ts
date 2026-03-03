/**
 * Tool registry — registers tools and dispatches execution.
 */

import type { OpenAIToolSchema } from '../types/index.js';
import type { Tool } from './base.js';

export class ToolRegistry {
  private readonly _tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  getDefinitions(): OpenAIToolSchema[] {
    return Array.from(this._tools.values()).map((t) => t.toSchema());
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this._tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}"`;
    }

    const errors = tool.validateParams(args);
    if (errors.length > 0) {
      return `Error: Invalid parameters — ${errors.join('; ')}`;
    }

    try {
      return await tool.execute(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error executing ${name}: ${msg}`;
    }
  }

  get size(): number {
    return this._tools.size;
  }
}
