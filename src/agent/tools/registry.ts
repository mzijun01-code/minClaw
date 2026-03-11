/**
 * 工具注册表：注册工具并按名称派发执行。
 * 执行前会做参数校验，失败或异常时在返回末尾附加重试提示。
 */

import type { OpenAIToolSchema } from '../../types/index.js';
import type { Tool } from './base.js';

/** 执行失败时追加的提示，引导模型换一种方式重试。 */
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

  /** 返回所有已注册工具的 OpenAI 函数定义，供 LLM 选用。 */
  getDefinitions(): OpenAIToolSchema[] {
    return Array.from(this._tools.values()).map((t) => t.toSchema());
  }

  get toolNames(): string[] {
    return Array.from(this._tools.keys());
  }

  /** 按名称执行工具：先校验参数，再执行；工具返回或抛错时附上 HINT。 */
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
      /* 工具自身返回的错误信息也附上重试提示 */
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
