import type { LogLevel } from './config.ts';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /^(authorization|api[-_]?key|token|access[-_]?token|password|secret|nula_api_key)$/i;

/** Masks bearer tokens and secret-looking fields so they never reach logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') {
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***').replace(/eyJ[A-Za-z0-9._-]{20,}/g, '***');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Logs to stderr only: on stdio transports stdout carries the MCP protocol. */
export function createLogger(
  level: LogLevel,
  sink: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): Logger {
  const emit = (lvl: LogLevel, msg: string, data?: unknown) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const suffix = data === undefined ? '' : ` ${JSON.stringify(redact(data))}`;
    sink(`[nulabg-mcp] ${new Date().toISOString()} ${lvl.toUpperCase()} ${redact(msg)}${suffix}`);
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
