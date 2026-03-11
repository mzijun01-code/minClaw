/**
 * 文件系统工具：read_file / write_file / edit_file / list_dir。
 * 支持相对路径基于 workspace，并可限制在 allowedDir 内防越权。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Tool } from './base.js';
import type { JSONSchema } from '../../types/index.js';

/** 解析路径：支持 ~、相对路径+workspace，并校验不超出 allowedDir。 */
function resolvePath(
  filePath: string,
  workspace?: string,
  allowedDir?: string,
): string {
  let p = filePath.startsWith('~')
    ? path.join(process.env.HOME ?? '', filePath.slice(1))
    : filePath;

  if (!path.isAbsolute(p) && workspace) {
    p = path.join(workspace, p);
  }

  const resolved = path.resolve(p);

  if (allowedDir) {
    const allowed = path.resolve(allowedDir);
    if (!resolved.startsWith(allowed + path.sep) && resolved !== allowed) {
      throw new Error(`Path "${filePath}" is outside allowed directory`);
    }
  }

  return resolved;
}

/** 读取指定路径文件内容，UTF-8。 */
export class ReadFileTool extends Tool {
  readonly name = 'read_file';
  readonly description = 'Read the contents of a file at the given path.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to read' },
    },
    required: ['path'],
  };

  constructor(
    private readonly _workspace?: string,
    private readonly _allowedDir?: string,
  ) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args['path'] as string;
    try {
      const resolved = resolvePath(filePath, this._workspace, this._allowedDir);
      if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`;
      if (!fs.statSync(resolved).isFile()) return `Error: Not a file: ${filePath}`;
      return fs.readFileSync(resolved, 'utf-8');
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** 写入文件，必要时递归创建父目录。 */
export class WriteFileTool extends Tool {
  readonly name = 'write_file';
  readonly description = 'Write content to a file. Creates parent directories if needed.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to write to' },
      content: { type: 'string', description: 'The content to write' },
    },
    required: ['path', 'content'],
  };

  constructor(
    private readonly _workspace?: string,
    private readonly _allowedDir?: string,
  ) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args['path'] as string;
    const content = args['content'] as string;
    try {
      const resolved = resolvePath(filePath, this._workspace, this._allowedDir);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      return `Successfully wrote ${content.length} bytes to ${resolved}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** 
 * 按 old_text 精确匹配替换为 new_text；
 * 若出现多次会要求提供更多上下文。
 */
export class EditFileTool extends Tool {
  readonly name = 'edit_file';
  readonly description =
    'Edit a file by replacing old_text with new_text. The old_text must exist exactly in the file.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to edit' },
      old_text: { type: 'string', description: 'The exact text to find and replace' },
      new_text: { type: 'string', description: 'The text to replace with' },
    },
    required: ['path', 'old_text', 'new_text'],
  };

  constructor(
    private readonly _workspace?: string,
    private readonly _allowedDir?: string,
  ) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args['path'] as string;
    const oldText = args['old_text'] as string;
    const newText = args['new_text'] as string;

    try {
      const resolved = resolvePath(filePath, this._workspace, this._allowedDir);
      if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`;

      const content = fs.readFileSync(resolved, 'utf-8');

      if (!content.includes(oldText)) {
        return _buildNotFoundMessage(oldText, content, filePath);
      }

      const count = content.split(oldText).length - 1;
      if (count > 1) {
        return `Warning: old_text appears ${count} times. Please provide more context to make it unique.`;
      }

      const newContent = content.replace(oldText, newText);
      fs.writeFileSync(resolved, newContent, 'utf-8');
      return `Successfully edited ${resolved}`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** old_text 未找到时，用行级相似度找最佳匹配并生成类 diff 提示。 */
function _buildNotFoundMessage(oldText: string, content: string, filePath: string): string {
  const lines = content.split('\n');
  const oldLines = oldText.split('\n');
  const window = oldLines.length;

  let bestRatio = 0;
  let bestStart = 0;

  for (let i = 0; i < Math.max(1, lines.length - window + 1); i++) {
    const chunk = lines.slice(i, i + window);
    const ratio = _sequenceSimilarity(oldLines, chunk);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestStart = i;
    }
  }

  if (bestRatio > 0.5) {
    const actual = lines.slice(bestStart, bestStart + window).join('\n');
    return (
      `Error: old_text not found in ${filePath}.\n` +
      `Best match (${Math.round(bestRatio * 100)}% similar) at line ${bestStart + 1}:\n` +
      `--- old_text (provided)\n+++ ${filePath} (actual)\n` +
      _unifiedDiff(oldText, actual)
    );
  }
  return `Error: old_text not found in ${filePath}. No similar text found. Verify the file content.`;
}

/** 两行数组的 Jaccard 式相似度（2*交集/总行数）。 */
function _sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  let matches = 0;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  for (const line of shorter) {
    if (longer.includes(line)) matches++;
  }
  return (2 * matches) / (a.length + b.length);
}

/** 生成简易 unified diff 风格的前后对比。 */
function _unifiedDiff(before: string, after: string): string {
  const aLines = before.split('\n');
  const bLines = after.split('\n');
  const result: string[] = [];
  const maxLen = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLen; i++) {
    const a = aLines[i];
    const b = bLines[i];
    if (a === b) { if (a !== undefined) result.push(` ${a}`); }
    else {
      if (a !== undefined) result.push(`-${a}`);
      if (b !== undefined) result.push(`+${b}`);
    }
  }
  return result.join('\n');
}

/** 列出目录内容，按名称排序，目录/文件用图标区分。 */
export class ListDirTool extends Tool {
  readonly name = 'list_dir';
  readonly description = 'List the contents of a directory.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The directory path to list' },
    },
    required: ['path'],
  };

  constructor(
    private readonly _workspace?: string,
    private readonly _allowedDir?: string,
  ) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = args['path'] as string;
    try {
      const resolved = resolvePath(dirPath, this._workspace, this._allowedDir);
      if (!fs.existsSync(resolved)) return `Error: Directory not found: ${dirPath}`;
      if (!fs.statSync(resolved).isDirectory()) return `Error: Not a directory: ${dirPath}`;

      const items = fs
        .readdirSync(resolved, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `📁 ${e.name}` : `📄 ${e.name}`));

      return items.length === 0 ? `Directory ${dirPath} is empty` : items.join('\n');
    } catch (err) {
      return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
