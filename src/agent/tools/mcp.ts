/**
 * MCP client — connects to MCP servers and wraps their tools as native minbot tools.
 *
 * Supports:
 *  - Stdio transport: spawn a local process and communicate over stdin/stdout
 *  - Streamable HTTP transport: connect to a remote MCP HTTP endpoint
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Tool } from './base.js';
import type { ToolRegistry } from './registry.js';
import type { JSONSchema } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Config types (mirrors nanobot MCPServerConfig)
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolTimeout?: number;
}

// ---------------------------------------------------------------------------
// Wrapper tool
// ---------------------------------------------------------------------------

class McpToolWrapper extends Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;

  private readonly _client: Client;
  private readonly _originalName: string;
  private readonly _toolTimeoutMs: number;

  constructor(
    client: Client,
    serverName: string,
    toolDef: { name: string; description?: string; inputSchema?: JSONSchema },
    toolTimeout = 30,
  ) {
    super();
    this._client = client;
    this._originalName = toolDef.name;
    this.name = `mcp_${serverName}_${toolDef.name}`;
    this.description = toolDef.description ?? toolDef.name;
    this.parameters = (toolDef.inputSchema as JSONSchema) ?? { type: 'object', properties: {} };
    this._toolTimeoutMs = toolTimeout * 1000;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), this._toolTimeoutMs),
    );

    try {
      const result = await Promise.race([
        this._client.callTool({ name: this._originalName, arguments: args }),
        timeoutPromise,
      ]);

      if (typeof result === 'string') return result;

      const parts: string[] = [];
      const content = (result as { content?: unknown[] }).content ?? [];
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            parts.push(b['text']);
          } else {
            parts.push(JSON.stringify(b));
          }
        }
      }
      return parts.join('\n') || '(no output)';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'timeout') {
        console.warn(`[mcp] Tool '${this.name}' timed out after ${this._toolTimeoutMs / 1000}s`);
        return `(MCP tool call timed out after ${this._toolTimeoutMs / 1000}s)`;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Connect + register
// ---------------------------------------------------------------------------

/**
 * Connect to all configured MCP servers and register their tools into the registry.
 * Returns cleanup functions to call on shutdown.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  registry: ToolRegistry,
): Promise<Array<() => Promise<void>>> {
  const cleanups: Array<() => Promise<void>> = [];

  for (const [name, cfg] of Object.entries(servers)) {
    let transport: Transport;

    try {
      if (cfg.command) {
        // Stdio mode: launch a local subprocess
        const env = { ...process.env, ...cfg.env } as Record<string, string>;
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env,
          stderr: 'pipe',
        });
      } else if (cfg.url) {
        // Streamable HTTP mode
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: {
            headers: cfg.headers ?? {},
          },
        });
      } else {
        console.warn(`[mcp] Server '${name}': no command or url configured, skipping`);
        continue;
      }

      const client = new Client({ name: 'minbot', version: '0.1.0' });
      await client.connect(transport);

      const toolList = await client.listTools();
      const toolTimeout = cfg.toolTimeout ?? 30;

      for (const toolDef of toolList.tools) {
        const looseDef = {
          name: toolDef.name,
          description: toolDef.description,
          inputSchema: toolDef.inputSchema as JSONSchema | undefined,
        };
        const wrapper = new McpToolWrapper(client, name, looseDef, toolTimeout);
        registry.register(wrapper);
        console.debug(`[mcp] Registered tool '${wrapper.name}' from server '${name}'`);
      }

      console.log(`[mcp] Server '${name}': connected, ${toolList.tools.length} tools registered`);

      cleanups.push(async () => {
        try {
          await client.close();
        } catch {
          // ignore
        }
      });
    } catch (e) {
      console.error(`[mcp] Server '${name}': failed to connect:`, e);
    }
  }

  return cleanups;
}
