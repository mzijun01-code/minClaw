/**
 * Web tools: web_search (Brave API) and web_fetch (HTML → text/markdown)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { Tool } from './base.js';
import type { JSONSchema } from '../types/index.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36';

function validateUrl(url: string): { ok: boolean; error?: string } {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, error: `Only http/https allowed, got "${parsed.protocol}"` };
    }
    if (!parsed.hostname) {
      return { ok: false, error: 'Missing domain' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function stripTags(html: string): string {
  const $ = cheerio.load(html);
  $('script, style').remove();
  return $.text().replace(/\s+/g, ' ').trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);

  $('script, style').remove();

  // Headings
  $('h1,h2,h3,h4,h5,h6').each((_i, el) => {
    const level = parseInt(el.tagName.slice(1));
    const text = $(el).text().trim();
    $(el).replaceWith(`${'#'.repeat(level)} ${text}\n`);
  });

  // Links
  $('a').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text().trim();
    $(el).replaceWith(text ? `[${text}](${href})` : href);
  });

  // Lists
  $('li').each((_i, el) => {
    $(el).replaceWith(`\n- ${$(el).text().trim()}`);
  });

  // Block elements → newlines
  $('p,div,section,article,br,hr').each((_i, el) => {
    $(el).after('\n\n');
  });

  return normalizeWhitespace($.text());
}

// ─── WebSearchTool ────────────────────────────────────────────────────────────

export class WebSearchTool extends Tool {
  readonly name = 'web_search';
  readonly description = 'Search the web. Returns titles, URLs, and snippets.';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: {
        type: 'integer',
        description: 'Number of results (1-10)',
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['query'],
  };

  constructor(
    private readonly _apiKey?: string,
    private readonly _maxResults = 5,
  ) {
    super();
  }

  private get apiKey(): string {
    return this._apiKey ?? process.env['TAVILY_API_KEY'] ?? process.env['BRAVE_API_KEY'] ?? '';
  }

  private get isTavily(): boolean {
    const key = this.apiKey;
    return key.startsWith('tvly-');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args['query'] as string;
    const count = Math.min(Math.max((args['count'] as number | undefined) ?? this._maxResults, 1), 10);

    if (!this.apiKey) {
      return (
        'Error: Search API key not configured. ' +
        'Set TAVILY_API_KEY (recommended) or BRAVE_API_KEY in your .env file.'
      );
    }

    try {
      if (this.isTavily) {
        return await this._tavilySearch(query, count);
      } else {
        return await this._braveSearch(query, count);
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async _tavilySearch(query: string, count: number): Promise<string> {
    const response = await axios.post<{
      results: Array<{ title: string; url: string; content?: string; score?: number }>;
    }>(
      'https://api.tavily.com/search',
      { query, max_results: count, search_depth: 'basic' },
      {
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15_000,
      },
    );

    const results = response.data.results ?? [];
    if (!results.length) return `No results for: ${query}`;

    const lines = [`Results for: ${query}\n`];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}\n   ${r.url}`);
      if (r.content) lines.push(`   ${r.content.slice(0, 200)}`);
    });
    return lines.join('\n');
  }

  private async _braveSearch(query: string, count: number): Promise<string> {
    const response = await axios.get<{
      web?: { results: Array<{ title: string; url: string; description?: string }> };
    }>('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query, count },
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
      timeout: 10_000,
    });

    const results = response.data.web?.results ?? [];
    if (!results.length) return `No results for: ${query}`;

    const lines = [`Results for: ${query}\n`];
    results.slice(0, count).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}\n   ${r.url}`);
      if (r.description) lines.push(`   ${r.description}`);
    });
    return lines.join('\n');
  }
}

// ─── WebFetchTool ─────────────────────────────────────────────────────────────

export class WebFetchTool extends Tool {
  readonly name = 'web_fetch';
  readonly description = 'Fetch a URL and extract readable content (HTML → markdown/text).';
  readonly parameters: JSONSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      extractMode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: 'Output format (default: markdown)',
      },
      maxChars: {
        type: 'integer',
        description: 'Maximum characters to return',
        minimum: 100,
      },
    },
    required: ['url'],
  };

  constructor(private readonly _maxChars = 50_000) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args['url'] as string;
    const extractMode = (args['extractMode'] as string | undefined) ?? 'markdown';
    const maxChars = (args['maxChars'] as number | undefined) ?? this._maxChars;

    const validation = validateUrl(url);
    if (!validation.ok) {
      return JSON.stringify({ error: `URL validation failed: ${validation.error}`, url });
    }

    try {
      const response = await axios.get<string>(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 30_000,
        maxRedirects: 5,
        responseType: 'text',
      });

      const contentType = String(response.headers['content-type'] ?? '');
      let text: string;
      let extractor: string;

      if (contentType.includes('application/json')) {
        text = JSON.stringify(response.data, null, 2);
        extractor = 'json';
      } else if (
        contentType.includes('text/html') ||
        String(response.data).slice(0, 256).toLowerCase().startsWith('<!doctype')
      ) {
        text = extractMode === 'markdown'
          ? htmlToMarkdown(String(response.data))
          : stripTags(String(response.data));
        extractor = 'cheerio';
      } else {
        text = String(response.data);
        extractor = 'raw';
      }

      const truncated = text.length > maxChars;
      if (truncated) text = text.slice(0, maxChars);

      return JSON.stringify({
        url,
        finalUrl: response.request?.res?.responseUrl ?? url,
        status: response.status,
        extractor,
        truncated,
        length: text.length,
        text,
      });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err), url });
    }
  }
}
