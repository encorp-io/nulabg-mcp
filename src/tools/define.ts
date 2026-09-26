import { pathToFileURL } from 'node:url';
import type {
  CallToolResult,
  ContentBlock,
  InputRequiredResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Config, Toolset } from '../config.ts';
import { saveDownload } from '../files.ts';
import type { Logger } from '../logger.ts';
import type { NulaClient } from '../nula/client.ts';
import type { FieldMap } from '../nula/errors.ts';

export interface ToolEnv {
  config: Config;
  logger: Logger;
  server: McpServer;
  clientFor(company?: string): NulaClient;
  fetch: typeof fetch;
}

export interface ToolCall {
  client: NulaClient;
  ctx: ServerContext;
  env: ToolEnv;
  /** Profile alias used for this call. */
  company: string;
}

export type ToolResult = CallToolResult | InputRequiredResult;

export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  name: string;
  toolset: Toolset;
  title: string;
  description: string;
  /** `read` tools stay available in read-only mode. */
  kind: 'read' | 'write';
  annotations?: Pick<ToolAnnotations, 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>;
  input: S;
  /** nula.bg field → MCP parameter, for mapping 422 validation errors back to what the model sent. */
  fieldMap?: FieldMap;
  run(args: z.infer<S>, call: ToolCall): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodObject>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

/** The serialised data of one result; with the text summary this stays around 5k tokens. */
export const MAX_RESULT_CHARS = 20_000;

/** Default number of records a search returns; nula.bg pages are 100 records, which is too much for a chat. */
export const DEFAULT_LIMIT = 25;

/** Trims a page of records to `limit` and explains what was left out. */
export function applyLimit<T>(items: T[], limit = DEFAULT_LIMIT): { items: T[]; note?: string } {
  if (items.length <= limit) return { items };
  return {
    items: items.slice(0, limit),
    note: `Showing ${limit} of ${items.length} records on this page. Raise limit (max 100) or narrow the filters.`,
  };
}

function json(data: unknown): string {
  return JSON.stringify(data, (_k, v) => (v === undefined ? undefined : v));
}

/**
 * Successful result: a short human summary plus the structured data (also serialised as text,
 * since not every client passes `structuredContent` to the model).
 */
export function ok(summary: string, data?: Record<string, unknown>, extra: ContentBlock[] = []): CallToolResult {
  const content: ContentBlock[] = [{ type: 'text', text: data ? `${summary}\n\n${json(data)}` : summary }, ...extra];
  return data ? { content, structuredContent: data } : { content };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Trims `data.items` from the end until the serialised result fits {@link MAX_RESULT_CHARS}.
 * Adds `truncated` and a hint to narrow the query.
 */
export function fitItems<T extends { items: unknown[] }>(
  data: T,
  hint: string,
): T & { truncated?: boolean; note?: string } {
  if (json(data).length <= MAX_RESULT_CHARS) return data;
  const items = [...data.items];
  const originalCount = items.length;
  while (items.length > 1 && json({ ...data, items }).length > MAX_RESULT_CHARS) items.pop();
  return {
    ...data,
    items,
    truncated: true,
    note: `Showing ${items.length} of ${originalCount} records to keep the response small. ${hint}`,
  };
}

/** Saves a file locally and returns a text line plus a resource_link to it. */
export async function deliverFile(
  config: Config,
  file: { bytes: Uint8Array; filename: string; mimeType: string },
  delivery: 'file' | 'embed',
  uri: string,
): Promise<{ summary: string; data: Record<string, unknown>; blocks: ContentBlock[] }> {
  const size = file.bytes.byteLength;
  if (delivery === 'embed') {
    if (size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB; use delivery "file" instead');
    return {
      summary: `${file.filename} (${Math.round(size / 1024)} KB) is embedded below.`,
      data: { filename: file.filename, mime_type: file.mimeType, size_bytes: size },
      blocks: [
        {
          type: 'resource',
          resource: { uri, mimeType: file.mimeType, blob: Buffer.from(file.bytes).toString('base64') },
        },
      ],
    };
  }
  const saved = await saveDownload(config, file.filename, file.bytes);
  return {
    summary: `Saved ${file.filename} (${Math.round(size / 1024)} KB) to ${saved}`,
    data: { path: saved, filename: file.filename, mime_type: file.mimeType, size_bytes: size },
    blocks: [
      { type: 'resource_link', uri: pathToFileURL(saved).href, name: file.filename, mimeType: file.mimeType, size },
    ],
  };
}
