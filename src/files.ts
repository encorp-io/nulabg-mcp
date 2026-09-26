import { lookup } from 'node:dns/promises';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from './config.ts';
import { expandHome } from './config.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export const fileInputSchema = z
  .object({
    path: z.string().min(1).optional().describe('Local file path (PDF, JPG or PNG). Only for locally running servers.'),
    url: z.string().url().optional().describe('https:// URL to download the file from.'),
    base64: z.string().min(1).optional().describe('File content as base64 (with or without a data: URI prefix).'),
    filename: z.string().min(1).optional().describe('File name, required with base64 (e.g. "invoice.pdf").'),
  })
  .describe('A PDF/JPG/PNG file: give exactly one of path, url or base64 (+ filename).')
  .superRefine((v, ctx) => {
    const given = [v.path, v.url, v.base64].filter((x) => x !== undefined).length;
    if (given !== 1) ctx.addIssue({ code: 'custom', message: 'Provide exactly one of path, url or base64' });
    if (v.base64 !== undefined && !v.filename) {
      ctx.addIssue({ code: 'custom', message: 'filename is required with base64', path: ['filename'] });
    }
  });
export type FileInput = z.infer<typeof fileInputSchema>;

export interface LoadedFile {
  bytes: Uint8Array;
  filename: string;
  mimeType: AllowedMime;
}

export class FileInputError extends Error {
  override name = 'FileInputError';
}

/** Detects the type from magic bytes; the file name or extension is never trusted. */
export function sniffMime(bytes: Uint8Array): AllowedMime | undefined {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return undefined;
}

function ensureAllowed(bytes: Uint8Array, filename: string): LoadedFile {
  if (bytes.byteLength === 0) throw new FileInputError(`${filename} is empty`);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new FileInputError(`${filename} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }
  const mimeType = sniffMime(bytes);
  if (!mimeType) throw new FileInputError(`${filename} is not a PDF, JPG or PNG file`);
  return { bytes, filename, mimeType };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function readLocal(p: string, config: Config): Promise<LoadedFile> {
  const requested = path.resolve(expandHome(p));
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new FileInputError(`File not found: ${requested}`);
  }
  const roots = await Promise.all(config.fileRoots.map((r) => realpath(r).catch(() => r)));
  if (!roots.some((root) => isInside(real, root))) {
    throw new FileInputError(
      `Access denied: ${real} is outside the allowed folders (${config.fileRoots.join(', ')}). Adjust NULA_FILE_ROOTS.`,
    );
  }
  const root = roots.find((r) => isInside(real, r)) ?? '';
  if (
    path
      .relative(root, real)
      .split(path.sep)
      .some((seg) => seg.startsWith('.'))
  ) {
    throw new FileInputError(`Access denied: hidden files and folders are not allowed (${real})`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new FileInputError(`Not a file: ${real}`);
  if (info.size > MAX_UPLOAD_BYTES) throw new FileInputError(`${real} is larger than 10 MB`);
  return ensureAllowed(new Uint8Array(await readFile(real)), path.basename(real));
}

const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0xc0000000, 24],
  [0xc6120000, 15],
  [0xe0000000, 3],
];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    return PRIVATE_V4.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'https:') throw new FileInputError('Only https:// URLs are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new FileInputError(`Refusing to download from a private or local address (${url.hostname})`);
  }
}

async function readUrl(raw: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<LoadedFile> {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHost(url);
    const timeout = AbortSignal.timeout(30_000);
    const res = await fetchImpl(url, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new FileInputError(`Download failed: HTTP ${res.status} for ${url.hostname}`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_UPLOAD_BYTES) throw new FileInputError('Remote file is larger than 10 MB');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'document');
    return ensureAllowed(bytes, name);
  }
  throw new FileInputError('Too many redirects');
}

export async function loadFile(
  input: FileInput,
  config: Config,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<LoadedFile> {
  if (input.path) return readLocal(input.path, config);
  if (input.url) return readUrl(input.url, opts.fetch ?? fetch, opts.signal);
  const b64 = (input.base64 ?? '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  return ensureAllowed(new Uint8Array(Buffer.from(b64, 'base64')), input.filename ?? 'document');
}

export function toDataUri(file: LoadedFile): string {
  return `data:${file.mimeType};base64,${Buffer.from(file.bytes).toString('base64')}`;
}

export function safeFilename(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[/\\?%*:|"<>\p{Cc}]/gu, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 150) || 'document';
}

/** Writes a downloaded document to NULA_DOWNLOAD_DIR and returns its absolute path. */
export async function saveDownload(config: Config, filename: string, bytes: Uint8Array): Promise<string> {
  await mkdir(config.downloadDir, { recursive: true });
  const target = path.join(config.downloadDir, safeFilename(filename));
  await writeFile(target, bytes);
  return target;
}
