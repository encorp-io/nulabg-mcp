import { z } from 'zod';
import { fileInputSchema, loadFile } from '../files.ts';
import type { NulaClient } from '../nula/client.ts';
import {
  extractList,
  isObj,
  normalizeBill,
  normalizeInvoice,
  type Obj,
  pickBool,
  pickNum,
  pickStr,
  stripUndefined,
  unwrap,
} from '../nula/normalize.ts';
import { defineTool, fail, fitItems, ok, type ToolCall } from './define.ts';

const documentType = z.enum(['bill', 'invoice']).describe('bill = покупка (purchase), invoice = продажба (sale)');

const DONE = /^(done|completed|complete|processed|success|successful|finished|ready|recognized)$/i;
const FAILED = /^(failed|error|rejected|unrecognized|cancelled|canceled)$/i;

export function uploadStatus(rec: Obj): 'processing' | 'done' | 'failed' {
  const s = pickStr(rec, 'status', 'ocr_status', 'state', 'processing_status');
  if (s && FAILED.test(s)) return 'failed';
  if (s && DONE.test(s)) return 'done';
  if (pickBool(rec, 'processed', 'is_processed', 'completed') === true) return 'done';
  if (!s && (pickNum(rec, 'total_amount', 'total') !== undefined || Array.isArray(rec.items))) return 'done';
  return 'processing';
}

function summarizeUpload(rec: Obj, type?: string): Obj {
  const t = (type ?? pickStr(rec, 'type', 'document_type', 'kind'))?.toLowerCase();
  const normalized = t?.includes('invoice') ? normalizeInvoice(rec) : normalizeBill(rec);
  return stripUndefined({
    id: pickNum(rec, 'id', 'upload_id', 'bill_id', 'invoice_id'),
    document_type: t?.includes('invoice') ? 'invoice' : t?.includes('bill') ? 'bill' : t,
    status: uploadStatus(rec),
    raw_status: pickStr(rec, 'status', 'ocr_status', 'state'),
    quality: pickStr(rec, 'quality', 'recognition_quality', 'confidence'),
    file_name: pickStr(rec, 'file_name', 'filename', 'original_name', 'name'),
    uploaded_at: pickStr(rec, 'created_at', 'uploaded_at'),
    error: pickStr(rec, 'error', 'error_message', 'failure_reason'),
    ...normalized,
  });
}

export async function readQuota(client: NulaClient, signal?: AbortSignal): Promise<Obj> {
  const data = unwrap(await client.get('/api/native/v1/ocr/quota', { signal }));
  const q = isObj(data) ? data : {};
  const free = pickNum(q, 'free_allowance', 'free', 'free_scans', 'allowance');
  const used = pickNum(q, 'used_this_cycle', 'used', 'usage', 'used_scans');
  const purchased = pickNum(q, 'purchased_credits', 'credits', 'purchased');
  const remaining =
    pickNum(q, 'remaining', 'scans_left', 'left', 'available') ??
    (free !== undefined && used !== undefined ? Math.max(free - used, 0) + (purchased ?? 0) : undefined);
  return stripUndefined({
    known: pickBool(q, 'known') ?? remaining !== undefined,
    free_allowance: free,
    used_this_cycle: used,
    purchased_credits: purchased,
    remaining,
  });
}

async function fetchUpload(client: NulaClient, type: string, id: number, signal?: AbortSignal): Promise<Obj> {
  const body = await client.get(`/api/native/v1/ocr/uploads/${type}/${id}`, { signal });
  const data = unwrap(body);
  const rec: Obj = isObj(data) ? { ...data } : {};
  if (isObj(body) && Array.isArray(body.items) && !rec.items) rec.items = body.items;
  return rec;
}

async function progress(call: ToolCall, value: number, total: number, message: string) {
  const token = call.ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return;
  await call.ctx.mcpReq
    .notify({ method: 'notifications/progress', params: { progressToken: token, progress: value, total, message } })
    .catch(() => {});
}

export const ocrUpload = defineTool({
  name: 'nula_ocr_upload',
  toolset: 'ocr',
  title: 'Scan documents with OCR',
  description:
    'Send 1–10 scanned documents (PDF/JPG/PNG) to nula.bg OCR, which creates purchase bills (покупки) or sales ' +
    'invoices from them. Each document uses OCR quota. By default waits for recognition and returns the ' +
    'extracted data so you can review it with the user.',
  kind: 'write',
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({
    files: z.array(fileInputSchema).min(1).max(10),
    document_type: documentType,
    wait_for_result: z.boolean().optional().describe('Wait for recognition (default true)'),
    timeout_seconds: z.number().int().min(5).max(240).optional().describe('Max wait, default 90'),
  }),
  async run(args, call) {
    const { client, ctx, env } = call;
    const signal = ctx.mcpReq.signal;
    const files = await Promise.all(args.files.map((f) => loadFile(f, env.config, { fetch: env.fetch, signal })));

    const quota = await readQuota(client, signal).catch(() => undefined);
    if (quota?.known && typeof quota.remaining === 'number' && quota.remaining < files.length) {
      return fail(`Not enough OCR scans: ${files.length} documents but only ${quota.remaining} scans left this cycle.`);
    }

    const form = new FormData();
    form.append('document_type', args.document_type);
    for (const f of files) {
      form.append(
        files.length === 1 ? 'file' : 'files[]',
        new Blob([Buffer.from(f.bytes)], { type: f.mimeType }),
        f.filename,
      );
    }
    const body = await client.post('/api/native/v1/ocr/uploads', {
      body: form,
      signal,
      timeoutMs: env.config.timeoutMs * 3,
    });
    const created = extractList(body).items.map((r) => summarizeUpload(r, args.document_type));
    if (created.length === 0)
      return ok('Documents were sent to OCR. Use nula_ocr_status to follow them.', { uploads: [] });

    if (args.wait_for_result === false) {
      return ok(`Queued ${created.length} documents for OCR. Check them later with nula_ocr_status.`, {
        uploads: created,
      });
    }

    const deadline = Date.now() + (args.timeout_seconds ?? 90) * 1000;
    const results = new Map<number, Obj>(
      created.filter((c) => typeof c.id === 'number').map((c) => [c.id as number, c]),
    );
    const pending = () => [...results.values()].filter((r) => r.status === 'processing');
    while (pending().length && Date.now() < deadline && !signal.aborted) {
      await progress(call, results.size - pending().length, results.size, 'Waiting for OCR recognition…');
      await new Promise((r) => setTimeout(r, 3000));
      for (const r of pending()) {
        try {
          const rec = await fetchUpload(client, args.document_type, r.id as number, signal);
          results.set(r.id as number, { ...summarizeUpload(rec, args.document_type), lines: undefined });
        } catch (err) {
          env.logger.debug('OCR poll failed', { id: r.id, err: String(err) });
        }
      }
    }
    const uploads = results.size ? [...results.values()] : created;
    const done = uploads.filter((u) => u.status === 'done').length;
    const failed = uploads.filter((u) => u.status === 'failed').length;
    const waiting = uploads.length - done - failed;
    return ok(
      `OCR: ${done} recognised, ${failed} failed, ${waiting} still processing.` +
        (waiting ? ' Check again later with nula_ocr_status.' : '') +
        ' Review the extracted data with the user; open a document with nula_ocr_status(document_type, id).',
      fitItems({ items: uploads }, 'Fetch documents one by one with nula_ocr_status.'),
    );
  },
});

export const ocrStatus = defineTool({
  name: 'nula_ocr_status',
  toolset: 'ocr',
  title: 'OCR uploads and quota',
  description:
    'List documents sent to OCR (newest first) with their recognition status, or get one recognised document ' +
    'with its lines (give document_type and id). Also reports the remaining OCR quota.',
  kind: 'read',
  input: z.object({
    document_type: documentType.optional(),
    id: z.number().int().positive().optional().describe('Upload id; requires document_type'),
    since: z.string().datetime({ offset: true }).optional().describe('Only uploads changed since this ISO 8601 time'),
    status: z.enum(['processing', 'done', 'failed']).optional(),
    limit: z.number().int().min(1).max(100).optional().describe('Max records (default 20)'),
    include_quota: z.boolean().optional().describe('Include remaining scans (default true)'),
  }),
  async run(args, { client, ctx }) {
    const signal = ctx.mcpReq.signal;
    if (args.id !== undefined) {
      if (!args.document_type) return fail('document_type is required together with id.');
      const rec = await fetchUpload(client, args.document_type, args.id, signal);
      const doc = {
        ...summarizeUpload(rec, args.document_type),
        ...(args.document_type === 'invoice' ? normalizeInvoice(rec, true) : normalizeBill(rec, true)),
      };
      return ok(`OCR ${args.document_type} ${args.id}: ${doc.status}.`, doc);
    }
    const body = await client.get('/api/native/v1/ocr/uploads', { query: { since: args.since }, signal });
    let uploads = extractList(body).items.map((r) => summarizeUpload(r));
    if (args.document_type) uploads = uploads.filter((u) => !u.document_type || u.document_type === args.document_type);
    if (args.status) uploads = uploads.filter((u) => u.status === args.status);
    uploads = uploads.slice(0, args.limit ?? 20);
    const quota = args.include_quota === false ? undefined : await readQuota(client, signal).catch(() => undefined);
    const quotaText = quota?.remaining !== undefined ? ` OCR scans left: ${quota.remaining}.` : '';
    return ok(`${uploads.length} OCR uploads.${quotaText}`, fitItems({ items: uploads, quota }, 'Use limit or since.'));
  },
});
