import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { type Config, loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/logger.ts';
import { createNulaServer } from '../src/server.ts';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Headers;
}

export interface FakeResponse {
  status?: number;
  json?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export type Routes = Record<string, (req: RecordedRequest) => FakeResponse | Promise<FakeResponse>>;

/** A fake nula.bg API: routes keyed by "METHOD /path", every request recorded. */
export function fakeNula(routes: Routes) {
  const calls: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    const req: RecordedRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: new Headers(init?.headers),
    };
    calls.push(req);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) {
      return new Response(JSON.stringify({ message: 'Not Found', statusCode: 404, errors: 'Resource not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const r = await handler(req);
    if (r.bytes) return new Response(Buffer.from(r.bytes), { status: r.status ?? 200, headers: r.headers });
    return new Response(JSON.stringify(r.json ?? { statusCode: 200, message: 'OK', data: null }), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

export const envelope = (data: unknown) => ({ json: { statusCode: 200, message: 'OK', data } });

/**
 * nula.bg's real list shape: `data` is an object keyed "0".."n" plus current_page / next_page / last_page.
 * Verified against the live API on 2026-09-26.
 */
export const keyedEnvelope = (
  records: unknown[],
  pages: { current_page?: number; next_page?: number | null; last_page?: number } = {},
) => ({
  json: {
    statusCode: 200,
    message: 'OK',
    data: {
      ...Object.fromEntries(records.map((r, i) => [String(i), r])),
      current_page: pages.current_page ?? 1,
      next_page: pages.next_page === undefined ? null : pages.next_page,
      last_page: pages.last_page ?? 1,
    },
  },
});

/** A realistic invoice record (real field names, invented values). */
export const invoiceRecord = (over: Record<string, unknown> = {}) => ({
  id: 5512,
  number: '0000000124',
  type: 1,
  recipient: 'Пример ООД',
  customer: {
    id: 81,
    name: 'Пример ООД',
    identifier: '204733952',
    vat_number: 'BG204733952',
    city: 'София',
    country: 'България',
  },
  amount: 600,
  amount_in_default_currency: 600,
  total_amount_in_default_currency: 720,
  vat_amount: 20,
  vat_value: '120.00',
  has_different_vats: false,
  vat_period: '2026-09',
  currency_code: 'EUR',
  default_currency_code: 'EUR',
  price_type: 'without_vat',
  status: 'Unpaid',
  status_id: 1,
  payment_method: 'Bank transfer',
  payment_method_id: 1,
  invoiced_at: '2026-09-22',
  created_at: '2026-09-22T08:00:00.000000Z',
  due_at: '2026-10-07',
  items: [
    {
      id: 1,
      item_id: 9,
      name: 'Консултации',
      sku: null,
      description: 'Консултации',
      quantity: 10,
      price: 60,
      vat_amount: 20,
    },
  ],
  ...over,
});

export function testConfig(env: Record<string, string> = {}): Config {
  const dir = mkdtempSync(path.join(tmpdir(), 'nulabg-mcp-'));
  return loadConfig({ NULA_API_KEY: 'test-key', NULA_DOWNLOAD_DIR: dir, NULA_FILE_ROOTS: dir, ...env });
}

export interface ConnectOptions {
  config?: Config;
  routes?: Routes;
  /** When set, the client declares elicitation support and answers with this. */
  elicit?: () => {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, string | number | boolean | string[]>;
  };
}

export async function connect(opts: ConnectOptions = {}) {
  // Write tools are opt-in (read-only is the default), so protocol tests enable them explicitly.
  const config = opts.config ?? testConfig({ NULA_READ_ONLY: 'false' });
  const api = fakeNula(opts.routes ?? {});
  const server = createNulaServer({ config, logger: silentLogger, fetch: api.fetch, retryBaseMs: 0 });
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: opts.elicit ? { elicitation: { form: {} } } : {} },
  );
  const elicitations: unknown[] = [];
  if (opts.elicit) {
    const answer = opts.elicit;
    client.setRequestHandler('elicitation/create', async (request) => {
      elicitations.push(request.params);
      return answer();
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, api, config, elicitations };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
