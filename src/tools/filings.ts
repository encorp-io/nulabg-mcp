/** НАП (NRA) declarations and НОИ (NOI) documents: monitoring only, no filing. */
import { z } from 'zod';
import {
  extractList,
  isObj,
  type Obj,
  pick,
  pickNum,
  pickStr,
  stripHeavy,
  stripUndefined,
  unwrap,
} from '../nula/normalize.ts';
import { defineTool, deliverFile, fail, fitItems, ok } from './define.ts';
import { deliverySchema, idParam } from './schemas.ts';

function fileList(rec: Obj): Obj[] {
  const files = pick(rec, 'files', 'attachments', 'documents');
  return Array.isArray(files) ? files.filter(isObj) : [];
}

function normalizeDeclaration(rec: Obj): Obj {
  return stripUndefined({
    id: pickNum(rec, 'id', 'submission_id'),
    type: pickStr(rec, 'type', 'declaration_type', 'form', 'kind'),
    period: pickStr(rec, 'period', 'tax_period', 'month'),
    status: pickStr(rec, 'status', 'state'),
    incoming_number: pickStr(rec, 'incoming_number', 'entry_number', 'vhodyasht_nomer', 'registration_number'),
    submitted_at: pickStr(rec, 'submitted_at', 'sent_at'),
    created_at: pickStr(rec, 'created_at'),
    result: pickStr(rec, 'result', 'result_message', 'processing_result'),
    files: fileList(rec)
      .map((f) => pickStr(f, 'name', 'filename', 'file_name'))
      .filter(Boolean),
  });
}

function decodeFile(f: Obj): { bytes: Uint8Array; filename: string } | undefined {
  const content = pickStr(f, 'content', 'base64', 'file', 'data');
  if (!content) return undefined;
  return {
    bytes: new Uint8Array(Buffer.from(content.replace(/^data:[^;]+;base64,/, ''), 'base64')),
    filename: pickStr(f, 'name', 'filename', 'file_name') ?? 'declaration.txt',
  };
}

const mimeFor = (name: string) =>
  name.endsWith('.xml') ? 'application/xml' : name.endsWith('.pdf') ? 'application/pdf' : 'text/plain';

export const nraDeclarations = defineTool({
  name: 'nula_nra_declarations',
  toolset: 'nra',
  title: 'НАП declarations',
  description:
    'List declarations prepared or submitted to НАП (NRA) from nula.bg (e.g. VAT returns), newest first, with ' +
    'status and входящ номер. Give submission_id and download_file to save one of its files. Monitoring only: ' +
    'this server cannot sign or file declarations.',
  kind: 'read',
  input: z.object({
    submission_id: idParam('declaration submission').optional(),
    download_file: z.string().optional().describe('File name to download from that submission'),
    status: z.string().optional().describe('Filter by status text, e.g. "draft" or "submitted"'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
    delivery: deliverySchema,
  }),
  async run(args, { client, ctx, env }) {
    const body = await client.get('/api/native/v1/nra/declarations', {
      signal: ctx.mcpReq.signal,
      timeoutMs: env.config.timeoutMs * 2,
    });
    const records = extractList(body).items;
    if (args.submission_id) {
      const rec = records.find((r) => pickNum(r, 'id', 'submission_id') === args.submission_id);
      if (!rec) return fail(`Submission ${args.submission_id} not found.`);
      if (args.download_file) {
        const file = fileList(rec).find((f) => pickStr(f, 'name', 'filename', 'file_name') === args.download_file);
        const decoded = file && decodeFile(file);
        if (!decoded) return fail(`File "${args.download_file}" not found in submission ${args.submission_id}.`);
        const out = await deliverFile(
          env.config,
          {
            ...decoded,
            filename: `nap-${args.submission_id}-${decoded.filename}`,
            mimeType: mimeFor(decoded.filename),
          },
          args.delivery ?? 'file',
          `nula://nra/${args.submission_id}/${encodeURIComponent(decoded.filename)}`,
        );
        return ok(out.summary, out.data, out.blocks);
      }
      const decl = normalizeDeclaration(rec);
      return ok(`Declaration ${decl.id}: ${decl.type ?? ''} ${decl.period ?? ''} · ${decl.status ?? ''}`, {
        ...decl,
        raw: stripHeavy(rec),
      });
    }
    let items = records.map(normalizeDeclaration);
    if (args.status)
      items = items.filter((d) =>
        String(d.status ?? '')
          .toLowerCase()
          .includes(args.status!.toLowerCase()),
      );
    items = items.slice(0, args.limit ?? 20);
    return ok(`${items.length} НАП declarations.`, fitItems({ items }, 'Use limit or status.'));
  },
});

export const nraRefreshResult = defineTool({
  name: 'nula_nra_refresh_result',
  toolset: 'nra',
  title: 'Refresh НАП processing result',
  description:
    'Ask НАП (NRA) again for the processing result of one submitted declaration and update its status in nula.bg.',
  kind: 'write',
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({ submission_id: idParam('declaration submission') }),
  async run(args, { client, ctx }) {
    const body = await client.post(`/api/native/v1/nra/declarations/${args.submission_id}/refresh-result`, {
      signal: ctx.mcpReq.signal,
      retry: true, // idempotent re-poll
    });
    const data = unwrap(body);
    const rec = isObj(data) && isObj(data.submission) ? data.submission : isObj(data) ? data : {};
    const decl = normalizeDeclaration(rec);
    const outcome = isObj(data) ? pickStr(data, 'outcome') : undefined;
    return ok(`Submission ${args.submission_id}: ${outcome ?? decl.status ?? 'refreshed'}.`, { ...decl, outcome });
  },
});

export const noiDocuments = defineTool({
  name: 'nula_noi_documents',
  toolset: 'noi',
  title: 'НОИ documents (Прил. 9/10/11)',
  description:
    'List НОИ (NOI) documents for employee leave (болнични, майчинство: Приложения 9/10/11) with period, employee, ' +
    'status and входящ номер. Download one with nula_noi_get_document.',
  kind: 'read',
  input: z.object({
    employee: z.string().optional().describe('Filter by employee name (partial)'),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async run(args, { client, ctx }) {
    const body = await client.get('/api/native/v1/noi/documents', { signal: ctx.mcpReq.signal });
    let items = extractList(body).items.map((r) =>
      stripUndefined({
        leave_id: pickNum(r, 'leave_id', 'id'),
        document: pickStr(r, 'document_type', 'type', 'appendix'),
        employee: pickStr(r, 'employee_name', 'employee.name', 'employee'),
        period_from: pickStr(r, 'from', 'start_date', 'period_from'),
        period_to: pickStr(r, 'to', 'end_date', 'period_to'),
        status: pickStr(r, 'status', 'submission_status', 'state'),
        incoming_number: pickStr(r, 'incoming_number', 'entry_number', 'registration_number'),
      }),
    );
    if (args.employee)
      items = items.filter((d) =>
        String(d.employee ?? '')
          .toLowerCase()
          .includes(args.employee!.toLowerCase()),
      );
    if (args.status)
      items = items.filter((d) =>
        String(d.status ?? '')
          .toLowerCase()
          .includes(args.status!.toLowerCase()),
      );
    items = items.slice(0, args.limit ?? 50);
    return ok(`${items.length} НОИ documents.`, fitItems({ items }, 'Filter by employee.'));
  },
});

export const noiGetDocument = defineTool({
  name: 'nula_noi_get_document',
  toolset: 'noi',
  title: 'Download НОИ document',
  description: "Download the НОИ XML (BPril9/10/11) of a leave, or the PDF with НОИ's submission result.",
  kind: 'read',
  input: z.object({
    leave_id: idParam('leave'),
    kind: z.enum(['xml', 'result_pdf']).describe('xml = the appendix XML; result_pdf = НОИ result'),
    delivery: deliverySchema,
  }),
  async run(args, { client, ctx, env }) {
    const signal = ctx.mcpReq.signal;
    if (args.kind === 'result_pdf') {
      const pdf = await client.getBinary(`/api/native/v1/noi/documents/${args.leave_id}/result-pdf`, { signal });
      const out = await deliverFile(
        env.config,
        { bytes: pdf.bytes, filename: `noi-${args.leave_id}-result.pdf`, mimeType: 'application/pdf' },
        args.delivery ?? 'file',
        `nula://noi/${args.leave_id}/result_pdf`,
      );
      return ok(out.summary, out.data, out.blocks);
    }
    const data = unwrap(await client.get(`/api/native/v1/noi/documents/${args.leave_id}/xml`, { signal }));
    const b64 =
      typeof data === 'string' ? data : isObj(data) ? pickStr(data, 'xml', 'content', 'base64', 'file') : undefined;
    if (!b64) return fail('nula.bg did not return XML content for this leave.');
    const bytes = new Uint8Array(Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64'));
    const name = (isObj(data) && pickStr(data, 'filename', 'name')) || `noi-${args.leave_id}.xml`;
    const out = await deliverFile(
      env.config,
      { bytes, filename: name, mimeType: 'application/xml' },
      args.delivery ?? 'file',
      `nula://noi/${args.leave_id}/xml`,
    );
    return ok(out.summary, out.data, out.blocks);
  },
});
