/**
 * LangChain-based LLM provider.
 *
 * Uses @langchain/openai (ChatOpenAI) which is compatible with any
 * OpenAI-format API: OpenAI, Anthropic via proxy, Ollama, DeepSeek, etc.
 *
 * Exposes a single chat() method matching the rest of the codebase.
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResponse, OpenAIToolSchema, ToolCallRequest } from '../types/index.js';

const DEBUG = Boolean(process.env.MINBOT_DEBUG || process.env.DEBUG);
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log('[DEBUG:llm]', ...args);
}

type InputMessage = {
  role: string;
  content: string | null;
  toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  toolCallId?: string;
  name?: string;
};

export interface LangChainProviderOptions {
  apiKey: string;
  apiBase?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class LangChainProvider {
  private readonly _model: string;
  private readonly _temperature: number;
  private readonly _maxTokens: number;
  private readonly _llm: ChatOpenAI;

  constructor(options: LangChainProviderOptions) {
    this._model = options.model;
    this._temperature = options.temperature ?? 0.1;
    this._maxTokens = options.maxTokens ?? 4096;

    this._llm = new ChatOpenAI({
      apiKey: options.apiKey,
      configuration: {
        baseURL: options.apiBase,
      },
      model: options.model,
      temperature: options.temperature ?? 0.1,
      maxTokens: options.maxTokens ?? 4096,
    });
  }

  get defaultModel(): string {
    return this._model;
  }

  /**
   * Send a chat completion request.
   *
   * @param messages  Conversation messages (system/user/assistant/tool)
   * @param tools     Optional list of tool schemas in OpenAI format
   * @param model     Override model for this call (creates a new LLM instance)
   */
  async chat(
    messages: InputMessage[],
    tools?: OpenAIToolSchema[],
    model?: string,
  ): Promise<LLMResponse> {
    try {
      const lcMessages = this._toLC(messages);

      // Build effective LLM (override model if needed)
      let llm: ChatOpenAI = this._llm;
      if (model && model !== this._model) {
        llm = new ChatOpenAI({
          apiKey: (this._llm as unknown as { apiKey: string }).apiKey,
          configuration: (this._llm as unknown as { clientConfig: object }).clientConfig,
          model,
          temperature: this._temperature,
          maxTokens: this._maxTokens,
        });
      }

      // Bind tools if provided
      const boundLlm = tools?.length ? llm.bind({ tools }) : llm;

      debugLog('invoke() start (waiting for API response)...');
      const response = await boundLlm.invoke(lcMessages);
      debugLog('invoke() done');
      return this._parseResponse(response as AIMessage);
    } catch (err) {
      console.error('[LLM] Error:', err);
      return {
        content: `Error calling LLM: ${err instanceof Error ? err.message : String(err)}`,
        toolCalls: [],
        finishReason: 'error',
      };
    }
  }

  /**
   * Convert our message format to LangChain BaseMessage array.
   */
  private _toLC(messages: InputMessage[]): BaseMessage[] {
    const result: BaseMessage[] = [];

    for (const m of messages) {
      const content = m.content ?? '';

      if (m.role === 'system') {
        result.push(new SystemMessage(content));
      } else if (m.role === 'user') {
        result.push(new HumanMessage(content));
      } else if (m.role === 'assistant') {
        if (m.toolCalls?.length) {
          result.push(
            new AIMessage({
              content: content,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                args: this._safeParseArgs(tc.function.arguments),
                type: 'tool_call' as const,
              })),
            }),
          );
        } else {
          result.push(new AIMessage(content));
        }
      } else if (m.role === 'tool') {
        result.push(
          new ToolMessage({
            content,
            tool_call_id: m.toolCallId ?? '',
            name: m.name,
          }),
        );
      }
    }

    return result;
  }

  private _safeParseArgs(args: string): Record<string, unknown> {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return { raw: args };
    }
  }

  /**
   * Parse LangChain response back to our LLMResponse format.
   */
  private _parseResponse(response: AIMessage): LLMResponse {
    const toolCalls: ToolCallRequest[] = [];

    // LangChain puts tool calls in response.tool_calls
    const lcToolCalls = response.tool_calls ?? [];
    for (const tc of lcToolCalls) {
      toolCalls.push({
        id: tc.id ?? `call_${Date.now()}`,
        name: tc.name,
        arguments: tc.args as Record<string, unknown>,
      });
    }

    // Also check additional_kwargs for raw tool_calls (some models)
    if (toolCalls.length === 0 && response.additional_kwargs?.['tool_calls']) {
      const rawCalls = response.additional_kwargs['tool_calls'] as Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
      for (const tc of rawCalls) {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: this._safeParseArgs(tc.function.arguments),
        });
      }
    }

    const content = typeof response.content === 'string' ? response.content : null;
    const usageMetadata = response.usage_metadata;

    return {
      content,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: usageMetadata
        ? {
            promptTokens: usageMetadata.input_tokens,
            completionTokens: usageMetadata.output_tokens,
            totalTokens: usageMetadata.total_tokens,
          }
        : undefined,
    };
  }
}
