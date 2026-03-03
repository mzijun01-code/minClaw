/**
 * Abstract base class for all agent tools.
 */

import type { JSONSchema, OpenAIToolSchema } from '../types/index.js';

export abstract class Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: JSONSchema;

  abstract execute(args: Record<string, unknown>): Promise<string>;

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
   * Validate parameters against the JSON schema.
   * Returns a list of error strings (empty = valid).
   */
  validateParams(params: Record<string, unknown>): string[] {
    return this._validate(params, { ...this.parameters, type: 'object' }, '');
  }

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

    // Object properties
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

    // Array items
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
