/**
 * 所有 Agent 工具的抽象基类。
 * 定义 name/description/parameters，提供参数校验与转 OpenAI 函数调用 schema。
 */

import type { JSONSchema, OpenAIToolSchema } from '../../types/index.js';

export abstract class Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: JSONSchema;

  abstract execute(args: Record<string, unknown>): Promise<string>;

  /** 转为 OpenAI function calling 所需的 schema。 */
  toSchema(): OpenAIToolSchema {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  /**
   * 按 JSON Schema 校验参数，返回错误信息列表，空数组表示合法。
   */
  validateParams(params: Record<string, unknown>): string[] {
    return this._validate(params, { ...this.parameters, type: 'object' }, '');
  }

  /** 递归校验值是否符合 schema，path 用于错误信息中的字段路径。 */
  private _validate(val: unknown, schema: Record<string, unknown>, path: string): string[] {
    const label = path || 'parameter';
    const t = schema['type'] as string | undefined;
    const errors: string[] = [];

    // Type check
    if (t && !this._checkType(val, t)) {
      return [`${label} should be ${t}`];
    }

    // Enum check
    const enumVals = schema['enum'] as unknown[] | undefined;
    if (enumVals && !enumVals.includes(val)) {
      errors.push(`${label} must be one of ${JSON.stringify(enumVals)}`);
    }

    // Numeric range
    if (t === 'integer' || t === 'number') {
      const num = val as number;
      const min = schema['minimum'] as number | undefined;
      const max = schema['maximum'] as number | undefined;
      if (min !== undefined && num < min) errors.push(`${label} must be >= ${min}`);
      if (max !== undefined && num > max) errors.push(`${label} must be <= ${max}`);
    }

    /* 对象：校验必填字段并递归校验各属性 */
    if (t === 'object' && typeof val === 'object' && val !== null) {
      const obj = val as Record<string, unknown>;
      const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema['required'] ?? []) as string[];

      for (const k of required) {
        if (!(k in obj)) {
          errors.push(`missing required ${path ? `${path}.${k}` : k}`);
        }
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k in props) {
          errors.push(
            ...this._validate(v, props[k], path ? `${path}.${k}` : k),
          );
        }
      }
    }

    /* 数组：按 items schema 校验每项 */
    if (t === 'array' && Array.isArray(val)) {
      const itemSchema = schema['items'] as Record<string, unknown> | undefined;
      if (itemSchema) {
        val.forEach((item, i) => {
          errors.push(
            ...this._validate(item, itemSchema, path ? `${path}[${i}]` : `[${i}]`),
          );
        });
      }
    }

    return errors;
  }

  /** 基础类型检查（string/integer/number/boolean/array/object）。 */
  private _checkType(val: unknown, type: string): boolean {
    switch (type) {
      case 'string': return typeof val === 'string';
      case 'integer': return Number.isInteger(val);
      case 'number': return typeof val === 'number';
      case 'boolean': return typeof val === 'boolean';
      case 'array': return Array.isArray(val);
      case 'object': return typeof val === 'object' && val !== null && !Array.isArray(val);
      default: return true;
    }
  }
}
