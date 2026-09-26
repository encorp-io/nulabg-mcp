import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const TOOLSETS = [
  'core',
  'invoices',
  'bills',
  'ocr',
  'customers',
  'inventory',
  'banking',
  'insights',
  'nra',
  'noi',
] as const;
export type Toolset = (typeof TOOLSETS)[number];

export const DEFAULT_TOOLSETS: readonly Toolset[] = [
  'core',
  'invoices',
  'bills',
  'ocr',
  'customers',
  'inventory',
  'banking',
  'insights',
];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  /** Named API keys. Always has at least one entry once validated for serving. */
  profiles: Record<string, string>;
  defaultProfile: string | undefined;
  baseUrl: string;
  toolsets: ReadonlySet<Toolset>;
  /** Default true: write tools are registered only with NULA_READ_ONLY=false. */
  readOnly: boolean;
  confirmWrites: 'elicit' | 'never';
  defaultCurrency: string;
  defaultLanguage: 'bg' | 'en';
  defaultInvoiceCategory: string | undefined;
  billCallbackUrl: string | undefined;
  downloadDir: string;
  fileRoots: string[];
  timeoutMs: number;
  maxConcurrency: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Read-only is the default and fails closed: only an explicit false/0/no/off enables write tools,
 * so a typo such as "ture" or an unexpanded placeholder never grants write access.
 */
export function parseReadOnly(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer, got "${value}"`);
  return n;
}

function parseProfiles(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === '') return {};
  let text = raw.trim();
  if (!text.startsWith('{')) {
    try {
      text = readFileSync(expandHome(text), 'utf8');
    } catch (err) {
      throw new ConfigError(`NULA_PROFILES: cannot read file "${raw}": ${(err as Error).message}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError('NULA_PROFILES must be a JSON object {"alias": "api-key", ...} or a path to such a file');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('NULA_PROFILES must be a JSON object {"alias": "api-key", ...}');
  }
  const out: Record<string, string> = {};
  for (const [alias, key] of Object.entries(parsed)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(alias)) {
      throw new ConfigError(`NULA_PROFILES: invalid alias "${alias}" (use letters, digits, "-" or "_")`);
    }
    if (typeof key !== 'string' || key.trim() === '') throw new ConfigError(`NULA_PROFILES: empty key for "${alias}"`);
    out[alias] = key.trim();
  }
  return out;
}

function parseToolsets(raw: string | undefined): Set<Toolset> {
  if (!raw || raw.trim() === '') return new Set(DEFAULT_TOOLSETS);
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes('all')) return new Set(TOOLSETS);
  const out = new Set<Toolset>(['core']);
  for (const name of names) {
    if (!(TOOLSETS as readonly string[]).includes(name)) {
      throw new ConfigError(`NULA_TOOLSETS: unknown toolset "${name}". Valid: ${TOOLSETS.join(', ')}, all`);
    }
    out.add(name as Toolset);
  }
  return out;
}

/** Reads configuration from environment variables. Does not require an API key (see {@link assertServable}). */
export function loadConfig(env: Env = process.env): Config {
  const profiles = parseProfiles(env.NULA_PROFILES);
  const apiKey = env.NULA_API_KEY?.trim();
  if (apiKey) profiles.default ??= apiKey;

  const aliases = Object.keys(profiles);
  let defaultProfile = env.NULA_DEFAULT_PROFILE?.trim() || (profiles.default ? 'default' : aliases[0]);
  if (defaultProfile && !profiles[defaultProfile]) {
    throw new ConfigError(`NULA_DEFAULT_PROFILE "${defaultProfile}" is not one of: ${aliases.join(', ')}`);
  }
  if (aliases.length === 0) defaultProfile = undefined;

  const baseUrl = (env.NULA_BASE_URL?.trim() || 'https://nula.bg').replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) {
    throw new ConfigError('NULA_BASE_URL must be an https:// URL');
  }

  const confirm = (env.NULA_CONFIRM_WRITES?.trim().toLowerCase() || 'elicit') as Config['confirmWrites'];
  if (!['elicit', 'never'].includes(confirm)) throw new ConfigError('NULA_CONFIRM_WRITES must be "elicit" or "never"');

  const language = (env.NULA_DEFAULT_LANGUAGE?.trim().toLowerCase() || 'bg') as Config['defaultLanguage'];
  if (!['bg', 'en'].includes(language)) throw new ConfigError('NULA_DEFAULT_LANGUAGE must be "bg" or "en"');

  const currency = (env.NULA_DEFAULT_CURRENCY?.trim().toUpperCase() || 'EUR') as string;
  if (!/^[A-Z]{3}$/.test(currency)) throw new ConfigError('NULA_DEFAULT_CURRENCY must be an ISO 4217 code, e.g. EUR');

  const logLevel = (env.NULA_LOG_LEVEL?.trim().toLowerCase() || 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError('NULA_LOG_LEVEL must be debug, info, warn or error');
  }

  const fileRoots = (env.NULA_FILE_ROOTS?.trim() || '~')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(expandHome(p)));

  const billCallbackUrl = env.NULA_BILL_CALLBACK_URL?.trim() || undefined;
  if (billCallbackUrl && !/^https:\/\//.test(billCallbackUrl)) {
    throw new ConfigError('NULA_BILL_CALLBACK_URL must be an https:// URL');
  }

  return {
    profiles,
    defaultProfile,
    baseUrl,
    toolsets: parseToolsets(env.NULA_TOOLSETS),
    readOnly: parseReadOnly(env.NULA_READ_ONLY),
    confirmWrites: confirm,
    defaultCurrency: currency,
    defaultLanguage: language,
    defaultInvoiceCategory: env.NULA_DEFAULT_INVOICE_CATEGORY?.trim() || undefined,
    billCallbackUrl,
    downloadDir: path.resolve(expandHome(env.NULA_DOWNLOAD_DIR?.trim() || '~/Downloads/nula')),
    fileRoots,
    timeoutMs: int(env.NULA_TIMEOUT_MS, 30_000, 'NULA_TIMEOUT_MS'),
    maxConcurrency: int(env.NULA_MAX_CONCURRENCY, 4, 'NULA_MAX_CONCURRENCY'),
    logLevel,
  };
}

export function assertServable(config: Config): void {
  if (!config.defaultProfile) {
    throw new ConfigError(
      'No nula.bg API key configured. Set NULA_API_KEY (or NULA_PROFILES for several companies). ' +
        'Create the key in your nula.bg account settings.',
    );
  }
}
