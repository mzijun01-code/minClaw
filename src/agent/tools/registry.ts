/**
 * Tool registry — registers tools and dispatches execution.
 */

import type { OpenAIToolSchema } from '../../types/index.js';
import type { Tool } from './base.js';

const HINT = '\n\n[Analyze the error above and try a different approach.]';

export class ToolRegistry {
  private readonly _tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this._tools.delete(name);
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

  get toolNames(): string[] {
    return Array.from(this._tools.keys());
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this._tools.get(name);
    if (!tool) {
      return `Error: Tool '${name}' not found. Available: ${this.toolNames.join(', ')}`;
    }

    const errors = tool.validateParams(args);
    if (errors.length > 0) {
      return `Error: Invalid parameters for tool '${name}': ${errors.join('; ')}${HINT}`;
    }

    try {
      const result = await tool.execute(args);
      if (typeof result === 'string' && result.startsWith('Error')) {
        return result + HINT;
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error executing ${name}: ${msg}${HINT}`;
    }
  }

  get size(): number {
    return this._tools.size;
  }
}
