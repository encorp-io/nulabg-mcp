import type { Logger } from '../logger.ts';
import { silentLogger } from '../logger.ts';

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export type NulaErrorKind = 'http' | 'network' | 'timeout' | 'aborted' | 'invalid_response';

/** An error returned by, or while talking to, the nula.bg API. */
export class NulaApiError extends Error {
  override name = 'NulaApiError';
  constructor(
    message: string,
    readonly kind: NulaErrorKind,
    readonly method: string,
    readonly path: string,
    readonly status?: number,
    /** `errors` field from the nula.bg envelope: a string or `{field: [messages]}`. */
    readonly errors?: unknown,
    readonly body?: unknown,
  ) {
    super(message);
  }

  /** True when a write request may or may not have been applied (timeout, network drop, 5xx). */
  get outcomeUnknown(): boolean {
    return this.method !== 'GET' && (this.kind !== 'http' || (this.status ?? 0) >= 500);
  }
}

export interface NulaClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  userAgent?: string;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Base for retry backoff in ms (tests set it to 0). */
  retryBaseMs?: number;
}

export interface RequestOptions {
  query?: Query;
  /** JSON body (objects) or multipart body (FormData). */
  body?: unknown;
  signal?: AbortSignal;
  /** Overrides the default: GET retries transient failures, writes never do. */
  retry?: boolean;
  timeoutMs?: number;
}

export interface BinaryResponse {
  bytes: Uint8Array;
  contentType: string;
  filename?: string;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return url.toString();
}

function envelopeMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.errors === 'string' && b.errors.trim()) return b.errors;
    if (typeof b.message === 'string' && b.message.trim()) return b.message;
  }
  return undefined;
}

/**
 * Thin HTTP client for the nula.bg REST API.
 *
 * - Adds the Bearer token, timeouts and a concurrency limit.
 * - Retries only idempotent requests (GET by default) on 429/502/503/504 and network errors.
 * - Treats the HTTP status as authoritative (nula.bg's body `statusCode` can disagree with it),
 *   but also fails a 2xx whose envelope carries an error `statusCode`.
 */
export class NulaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly semaphore: Semaphore;
  private readonly logger: Logger;
  readonly baseUrl: string;

  constructor(private readonly opts: NulaClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.semaphore = new Semaphore(opts.maxConcurrency ?? 4);
    this.logger = opts.logger ?? silentLogger;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  get<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestJson<T>('GET', path, options);
  }
  post<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestJson<T>('POST', path, options);
  }
  patch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestJson<T>('PATCH', path, options);
  }
  delete<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestJson<T>('DELETE', path, options);
  }

  async getBinary(path: string, options: RequestOptions = {}): Promise<BinaryResponse> {
    const res = await this.send('GET', path, options, 'application/pdf, application/octet-stream, */*');
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    if (contentType.includes('application/json')) {
      const body = await this.parseJson(res, 'GET', path);
      throw new NulaApiError(
        envelopeMessage(body) ?? 'Expected a file but nula.bg returned JSON',
        'invalid_response',
        'GET',
        path,
        res.status,
        undefined,
        body,
      );
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType,
      filename: filename ? decodeURIComponent(filename) : undefined,
    };
  }

  private async requestJson<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const res = await this.send(method, path, options, 'application/json');
    const body = await this.parseJson(res, method, path);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const sc = (body as Record<string, unknown>).statusCode;
      const code = typeof sc === 'string' ? Number.parseInt(sc, 10) : sc;
      if (typeof code === 'number' && code >= 400) {
        const errors = (body as Record<string, unknown>).errors;
        throw new NulaApiError(
          envelopeMessage(body) ?? `nula.bg error ${code}`,
          'http',
          method,
          path,
          code,
          errors,
          body,
        );
      }
    }
    return body as T;
  }

  private async parseJson(res: Response, method: string, path: string): Promise<unknown> {
    const text = await res.text();
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new NulaApiError(
        `nula.bg returned a non-JSON response (HTTP ${res.status})`,
        'invalid_response',
        method,
        path,
        res.status,
        undefined,
        text.slice(0, 500),
      );
    }
  }

  private async send(method: string, path: string, options: RequestOptions, accept: string): Promise<Response> {
    const url = buildUrl(this.baseUrl, path, options.query);
    const retry = options.retry ?? method === 'GET';
    const attempts = retry ? MAX_ATTEMPTS : 1;
    const baseMs = this.opts.retryBaseMs ?? 500;

    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.semaphore.run(() => this.once(method, url, path, options, accept));
        if (res.ok) return res;

        if (retry && attempt < attempts && RETRY_STATUSES.has(res.status)) {
          const retryAfter = Number.parseFloat(res.headers.get('retry-after') ?? '');
          const wait = Number.isFinite(retryAfter)
            ? Math.min(retryAfter * 1000, 10_000)
            : baseMs * 2 ** (attempt - 1) + Math.random() * baseMs;
          this.logger.warn(`nula.bg ${method} ${path} → ${res.status}, retrying in ${Math.round(wait)}ms`);
          await res.body?.cancel().catch(() => {});
          await sleep(wait, options.signal);
          continue;
        }

        const text = await res.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          /* keep text */
        }
        const errors = body && typeof body === 'object' ? (body as Record<string, unknown>).errors : undefined;
        throw new NulaApiError(
          envelopeMessage(body) ?? `nula.bg returned HTTP ${res.status}`,
          'http',
          method,
          path,
          res.status,
          errors,
          body,
        );
      } catch (err) {
        if (err instanceof NulaApiError) throw err;
        const e = err as Error;
        const aborted = options.signal?.aborted;
        const timedOut = e.name === 'TimeoutError';
        const kind: NulaErrorKind = aborted ? 'aborted' : timedOut ? 'timeout' : 'network';
        if (!aborted && retry && attempt < attempts) {
          this.logger.warn(`nula.bg ${method} ${path} failed (${e.message}), retrying`);
          await sleep(baseMs * 2 ** (attempt - 1), options.signal);
          continue;
        }
        throw new NulaApiError(
          kind === 'timeout'
            ? `nula.bg did not answer within ${options.timeoutMs ?? this.opts.timeoutMs ?? 30_000} ms`
            : kind === 'aborted'
              ? 'Request was cancelled'
              : `Cannot reach nula.bg: ${e.message}`,
          kind,
          method,
          path,
        );
      }
    }
  }

  private once(method: string, url: string, path: string, options: RequestOptions, accept: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      Accept: accept,
      'User-Agent': this.opts.userAgent ?? 'nulabg-mcp',
    };
    let body: FormData | string | undefined;
    if (options.body instanceof FormData) {
      body = options.body;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.opts.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    this.logger.debug(`→ ${method} ${path}`, options.query);
    return this.fetchImpl(url, { method, headers, body, signal });
  }
}
