/**
 * Filesystem tools: read_file, write_file, edit_file, list_dir
 */

import fs from 'node:fs';
import path from 'node:path';
import { Tool } from './base.js';
import type { JSONSchema } from '../types/index.js';

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

// ─── ReadFileTool ─────────────────────────────────────────────────────────────

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

// ─── WriteFileTool ────────────────────────────────────────────────────────────

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

// ─── EditFileTool ─────────────────────────────────────────────────────────────

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
        return `Error: old_text not found in ${filePath}. Verify the file content.`;
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

// ─── ListDirTool ──────────────────────────────────────────────────────────────

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
