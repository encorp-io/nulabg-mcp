import { z } from 'zod';
import { fileInputSchema, loadFile, toDataUri } from '../files.ts';
import { resolveRange, toDateRange } from '../mappers/dates.ts';
import { buildInvoicePayload, INVOICE_FIELD_MAP, type InvoiceInput } from '../mappers/documents.ts';
import {
  DOCUMENT_TYPE_LABELS_BG,
  INVOICE_FILTER_TYPES,
  INVOICE_PAYMENT_METHODS,
  LINE_KINDS,
} from '../mappers/enums.ts';
import { EMAIL_PATTERN, padDocNumber } from '../mappers/identifiers.ts';
import { formatMoney } from '../mappers/money.ts';
import type { NulaClient } from '../nula/client.ts';
import { extractList, isObj, normalizeInvoice, pickBool, pickNum, pickStr, unwrap } from '../nula/normalize.ts';
import { confirmAction } from './confirm.ts';
import { applyLimit, defineTool, deliverFile, fail, fitItems, ok, type ToolCall } from './define.ts';
import {
  categories,
  customerSchema,
  deliverySchema,
  docNumber,
  idParam,
  isoDate,
  language,
  page,
  responseFormat,
  vatRate,
} from './schemas.ts';

// ---------------------------------------------------------------- helpers

/**
 * Looks a document up by number. `getInvoices?number=` returns the full record (with lines);
 * `getInvoicesByNumber` only returns a stub (id, number, type, created_at), so it is just a fallback.
 */
export async function findInvoicesByNumber(client: NulaClient, number: string, signal?: AbortSignal) {
  const padded = padDocNumber(number);
  const full = extractList(await client.get('/api/v1/getInvoices', { query: { number: padded }, signal })).items;
  if (full.length > 0) return full;
  return extractList(await client.get('/api/v1/getInvoicesByNumber', { query: { number: padded }, signal })).items;
}

function summaryLine(inv: Record<string, unknown>): string {
  const customer = isObj(inv.customer) ? (inv.customer.name as string | undefined) : undefined;
  const type =
    typeof inv.document_type === 'string'
      ? (DOCUMENT_TYPE_LABELS_BG[inv.document_type] ?? inv.document_type)
      : 'документ';
  const status =
    inv.payment_status === 'paid'
      ? 'платена'
      : inv.payment_status === 'partially_paid'
        ? 'частично платена'
        : inv.payment_status === 'unpaid'
          ? 'неплатена'
          : inv.payment_status === 'invalid'
            ? 'анулирана'
            : '';
  return [
    `№${inv.number ?? '?'}`,
    type,
    inv.issue_date,
    customer,
    formatMoney(inv.total as number | undefined, (inv.currency as string) ?? 'EUR'),
    status,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------- search

export const searchInvoices = defineTool({
  name: 'nula_search_invoices',
  toolset: 'invoices',
  title: 'Search sales invoices',
  description:
    'Find sales documents (фактури, проформи, дебитни/кредитни известия) by period, customer, type or number. ' +
    'Pass `number` to get one document in full, including its lines. Without document_type, proformas are excluded.',
  kind: 'read',
  input: z.object({
    number: docNumber.optional().describe('Exact document number; returns that document in full, with its lines'),
    date_from: isoDate.optional().describe('Start of period (YYYY-MM-DD), by date'),
    date_to: isoDate.optional().describe('End of period (YYYY-MM-DD), inclusive'),
    document_type: z.enum(['invoice', 'proforma', 'debit_note', 'credit_note']).optional(),
    customer_name: z.string().optional(),
    customer_eik: z.string().optional(),
    customer_vat_number: z.string().optional(),
    page,
    limit: z.number().int().min(1).max(100).optional().describe('Max records to return from the page (default 25)'),
    response_format: responseFormat,
  }),
  async run(args, { client, ctx }) {
    if (args.number) {
      const items = (await findInvoicesByNumber(client, args.number, ctx.mcpReq.signal)).map((i) =>
        normalizeInvoice(i, true),
      );
      if (items.length === 0) return ok(`No document with number ${padDocNumber(args.number)}.`, { items: [] });
      return ok(items.map(summaryLine).join('\n'), fitItems({ items }, 'Use response_format "concise".'));
    }
    const range = resolveRange(args.date_from, args.date_to);
    const body = await client.get('/api/v1/getInvoices', {
      query: {
        daterange: range ? toDateRange(range.from, range.to) : undefined,
        page: args.page,
        type: args.document_type ? INVOICE_FILTER_TYPES[args.document_type] : undefined,
        name: args.customer_name,
        identifier: args.customer_eik,
        vat_number: args.customer_vat_number,
      },
      signal: ctx.mcpReq.signal,
    });
    const { items, page: pg } = extractList(body, args.page ?? 1);
    const detailed = args.response_format === 'detailed';
    const { items: invoices, note } = applyLimit(
      items.map((i) => normalizeInvoice(i, detailed)),
      args.limit,
    );
    const head =
      `${invoices.length} documents${range ? ` from ${range.from} to ${range.to}` : ''}` +
      `${pg.has_more ? ' (more pages available)' : ''}.${note ? ` ${note}` : ''}`;
    return ok(
      [head, ...invoices.map(summaryLine)].join('\n'),
      fitItems({ items: invoices, ...pg, note }, 'Narrow the period or filter by customer.'),
    );
  },
});

// ---------------------------------------------------------------- create / update

const invoiceLine = z.object({
  name: z.string().min(1).describe('Item or service name (артикул/услуга)'),
  description: z.string().optional().describe('Line description (defaults to name)'),
  sku: z.string().optional().describe('Item code (Арт. номер); matches an existing item'),
  quantity: z.number().positive(),
  unit_price: z.number().describe('Price per unit; with or without VAT according to prices_include_vat'),
  kind: z
    .enum(Object.keys(LINE_KINDS) as ['product', 'goods', 'service', 'advance'])
    .describe('product = 701 продукция, goods = 702 стоки, service = 703 услуги, advance = 412 аванс'),
  vat_rate: vatRate.optional().describe('Only if this line has a different VAT rate than the invoice'),
  existing_item_only: z.boolean().optional().describe('Do not create a new item; fail if not found by sku/name'),
});

const invoiceContent = {
  customer: customerSchema,
  document_type: z
    .enum([
      'invoice',
      'proforma',
      'debit_note',
      'credit_note',
      'protocol',
      'protocol_personal_use',
      'protocol_vat_charge',
    ])
    .optional()
    .describe('Default "invoice" (фактура)'),
  issue_date: isoDate.optional().describe('Дата на издаване (default: today in Sofia)'),
  tax_event_date: isoDate.optional().describe('Дата на данъчно събитие (default: issue_date)'),
  due_date: isoDate.optional().describe('Payment due date (падеж)'),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .describe('ISO currency, default EUR'),
  exchange_rate: z.number().positive().optional().describe('Exchange rate for foreign currency'),
  prices_include_vat: z
    .boolean()
    .describe('true if unit_price already includes VAT, false if VAT is added on top. Ask the user if unclear.'),
  vat_rate: vatRate.optional().describe('VAT rate for the document (default 20)'),
  zero_vat_reason: z
    .number()
    .int()
    .min(1)
    .max(57)
    .optional()
    .describe(
      'Required with a 0% rate. Legal basis code, e.g. 19 = чл.146 ЗДДС (see nula://reference/zero-vat-reasons)',
    ),
  payment_method: z.enum(
    Object.keys(INVOICE_PAYMENT_METHODS) as ['bank_transfer', 'cash', 'card', 'cash_on_delivery', 'postal_money_order'],
  ),
  iban: z.string().optional().describe('Your bank account for payment; defaults to the main account in nula.bg'),
  paid_amount: z.number().min(0).optional().describe('Amount already paid'),
  note: z.string().max(2000).optional(),
  categories: categories
    .optional()
    .describe('Categories/tags; at least one is required by nula.bg unless a default is configured'),
  oss_country: z.string().length(2).optional().describe('EU country code for the OSS regime, e.g. "DE"'),
  lines: z.array(invoiceLine).min(1).max(200),
};

async function previewExtras(args: InvoiceInput, call: ToolCall) {
  const signal = call.ctx.mcpReq.signal;
  const extras: Record<string, unknown> = {};
  if (!args.number) {
    try {
      const body = await call.client.get('/api/v1/getNextInvoiceNumber', {
        query: { type: args.document_type === 'proforma' ? 0 : 1 },
        signal,
      });
      const data = unwrap(body);
      extras.next_number = isObj(data) ? pickStr(data, 'number', 'next_number', 'invoice_number') : (data ?? undefined);
    } catch {
      /* preview stays useful without it */
    }
  }
  const search = args.customer.eik ?? args.customer.vat_number ?? args.customer.name;
  try {
    const body = await call.client.get('/api/v1/customers', { query: { search }, signal });
    const { items } = extractList(body);
    extras.customer_exists = items.length > 0;
    if (items[0])
      extras.existing_customer = { id: pickNum(items[0], 'id'), name: pickStr(items[0], 'name', 'company_name') };
  } catch {
    /* ignore */
  }
  return extras;
}

export const createInvoice = defineTool({
  name: 'nula_create_invoice',
  toolset: 'invoices',
  title: 'Create a sales invoice',
  description:
    'Create a sales document (фактура, проформа, дебитно/кредитно известие, протокол) in nula.bg. ' +
    'ALWAYS call first with preview_only: true and show the user the preview (number, customer, lines, totals); ' +
    'create it only after the user confirms. Look up unfamiliar customers with nula_lookup_company first. ' +
    'A missing customer and missing items are created automatically in nula.bg.',
  kind: 'write',
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  fieldMap: INVOICE_FIELD_MAP,
  input: z.object({
    ...invoiceContent,
    number: docNumber.optional().describe('Leave empty to use the next number in the series'),
    attachment: fileInputSchema.optional().describe('Optional file to attach (PDF/JPG/PNG)'),
    preview_only: z.boolean().optional().describe('Validate and show totals without creating anything'),
  }),
  async run(args, call) {
    const { client, ctx, env } = call;
    const built = buildInvoicePayload(args, env.config);
    if (built.errors.length) {
      return fail(
        `Cannot create the invoice:\n- ${built.errors.join('\n- ')}${built.warnings.length ? `\nWarnings:\n- ${built.warnings.join('\n- ')}` : ''}`,
      );
    }
    const t = built.totals;
    const typeLabel = DOCUMENT_TYPE_LABELS_BG[args.document_type ?? 'invoice'];

    if (args.preview_only) {
      const extras = await previewExtras(args, call);
      const number = args.number ? padDocNumber(args.number) : (extras.next_number as string | undefined);
      return ok(
        `PREVIEW (nothing created): ${typeLabel}${number ? ` №${number}` : ''} for ${args.customer.name}: ` +
          `net ${formatMoney(t.net, t.currency)}, VAT ${formatMoney(t.vat, t.currency)}, total ${formatMoney(t.total, t.currency)}. ` +
          'Totals are approximate; nula.bg computes the final amounts. Ask the user to confirm, then call again without preview_only.',
        { preview: true, number, totals: t, warnings: built.warnings, ...extras, payload: built.payload },
      );
    }

    if (args.number) {
      const existing = await findInvoicesByNumber(client, args.number, ctx.mcpReq.signal);
      if (existing.length)
        return fail(`Invoice number ${padDocNumber(args.number)} already exists in nula.bg. Nothing was created.`);
    }

    const confirmation = confirmAction(
      call,
      `Създаване на ${typeLabel}${args.number ? ` №${padDocNumber(args.number)}` : ''} за ${args.customer.name} на обща стойност ${formatMoney(t.total, t.currency)}?`,
    );
    if (confirmation.status !== 'confirmed') return confirmation.result;

    if (args.attachment) {
      const file = await loadFile(args.attachment, env.config, { fetch: env.fetch, signal: ctx.mcpReq.signal });
      built.payload.file = toDataUri(file);
    }

    const body = await client.post('/api/v1/createInvoice', { body: built.payload, signal: ctx.mcpReq.signal });
    const data = unwrap(body);
    const id = isObj(data) ? pickNum(data, 'id', 'invoice_id') : undefined;
    const number = isObj(data) ? pickStr(data, 'number', 'invoice_number') : undefined;
    return ok(
      `Created ${typeLabel}${number ? ` №${number}` : ''}${id ? ` (id ${id})` : ''} for ${args.customer.name}, total ≈ ${formatMoney(t.total, t.currency)}. ` +
        'Next: nula_get_invoice_pdf or nula_email_invoice.',
      {
        id,
        number,
        document_type: args.document_type ?? 'invoice',
        customer: args.customer.name,
        totals: t,
        warnings: built.warnings,
      },
    );
  },
});

export const updateInvoice = defineTool({
  name: 'nula_update_invoice',
  toolset: 'invoices',
  title: 'Replace an invoice’s content',
  description:
    'Replace the content (customer, dates, lines, amounts) of an existing invoice. nula.bg overwrites the whole ' +
    'document, so first read it with nula_search_invoices(number) and send the COMPLETE corrected document. ' +
    'For paid/sent status or categories only, use nula_update_invoice_metadata instead.',
  kind: 'write',
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  fieldMap: INVOICE_FIELD_MAP,
  input: z.object({ invoice_id: idParam('invoice'), ...invoiceContent }),
  async run(args, call) {
    const built = buildInvoicePayload(args, call.env.config);
    if (built.errors.length) return fail(`Cannot update the invoice:\n- ${built.errors.join('\n- ')}`);
    const t = built.totals;
    const confirmation = confirmAction(
      call,
      `Презаписване на фактура id ${args.invoice_id} (${args.customer.name}, ${formatMoney(t.total, t.currency)})?`,
    );
    if (confirmation.status !== 'confirmed') return confirmation.result;
    await call.client.patch(`/api/v1/editInvoice/${args.invoice_id}`, {
      body: built.payload,
      signal: call.ctx.mcpReq.signal,
    });
    return ok(`Invoice ${args.invoice_id} updated (total ≈ ${formatMoney(t.total, t.currency)}).`, {
      id: args.invoice_id,
      totals: t,
      warnings: built.warnings,
    });
  },
});

export const updateInvoiceMetadata = defineTool({
  name: 'nula_update_invoice_metadata',
  toolset: 'invoices',
  title: 'Mark paid/sent, set categories, attach file',
  description:
    "Change an invoice's paid/sent status, replace its categories (категории) or attach a file, without touching " +
    'its lines or amounts. Give at least one of is_paid, is_sent, categories, attachment.',
  kind: 'write',
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({
    invoice_id: idParam('invoice'),
    number: docNumber
      .optional()
      .describe('Invoice number; needed to read the current status if only one flag is given'),
    is_paid: z.boolean().optional().describe('Mark as paid (платена) or unpaid'),
    is_sent: z.boolean().optional().describe('Mark as sent (изпратена) or not sent'),
    categories: categories.optional(),
    attachment: fileInputSchema.optional(),
  }),
  async run(args, { client, ctx, env }) {
    const signal = ctx.mcpReq.signal;
    if (args.is_paid === undefined && args.is_sent === undefined && !args.categories && !args.attachment) {
      return fail('Nothing to change: give is_paid, is_sent, categories or attachment.');
    }
    const done: string[] = [];
    if (args.is_paid !== undefined || args.is_sent !== undefined) {
      let paid = args.is_paid;
      let sent = args.is_sent;
      if (paid === undefined || sent === undefined) {
        if (!args.number) {
          return fail(
            'nula.bg needs both is_paid and is_sent. Give both, or give `number` so the current state can be read.',
          );
        }
        const current = (await findInvoicesByNumber(client, args.number, signal))
          .map((i) => normalizeInvoice(i))
          .find((i) => i.id === args.invoice_id || i.id === undefined);
        paid ??= current?.is_paid as boolean | undefined;
        sent ??= current?.is_sent as boolean | undefined;
        if (paid === undefined || sent === undefined) {
          return fail('Could not read the current paid/sent state from nula.bg. Please give both is_paid and is_sent.');
        }
      }
      await client.patch(`/api/v1/setInvoiceStatus/${args.invoice_id}`, {
        body: { set_as_paid: paid ? 1 : 0, set_as_sent: sent ? 1 : 0 },
        signal,
      });
      done.push(`status: ${paid ? 'paid' : 'unpaid'}, ${sent ? 'sent' : 'not sent'}`);
    }
    if (args.categories) {
      await client.post(`/api/v1/invoice/${args.invoice_id}/category`, { body: { tags: args.categories }, signal });
      done.push(`categories: ${args.categories.join(', ')}`);
    }
    if (args.attachment) {
      const file = await loadFile(args.attachment, env.config, { fetch: env.fetch, signal });
      await client.post(`/api/v1/invoice/${args.invoice_id}/attachFile`, { body: { media: toDataUri(file) }, signal });
      done.push(`attached ${file.filename}`);
    }
    return ok(`Invoice ${args.invoice_id} updated: ${done.join('; ')}.`, { id: args.invoice_id, changes: done });
  },
});

// ---------------------------------------------------------------- files, e-mail, delete

export const getInvoicePdf = defineTool({
  name: 'nula_get_invoice_pdf',
  toolset: 'invoices',
  title: 'Download invoice PDF',
  description: 'Download the PDF of an invoice in Bulgarian or English and save it locally (or return it inline).',
  kind: 'read',
  input: z.object({
    invoice_id: idParam('invoice'),
    number: docNumber.optional().describe('Invoice number, used for the file name'),
    language,
    delivery: deliverySchema,
  }),
  async run(args, { client, ctx, env }) {
    const lang = args.language ?? env.config.defaultLanguage;
    const pdf = await client.getBinary(`/api/v1/invoices/${args.invoice_id}/getInvoicePDF`, {
      query: { in_english: lang === 'en' ? 1 : 0 },
      signal: ctx.mcpReq.signal,
    });
    const base = args.number ? padDocNumber(args.number) : `invoice-${args.invoice_id}`;
    const filename = `${base}${lang === 'en' ? '-en' : ''}.pdf`;
    const out = await deliverFile(
      env.config,
      { bytes: pdf.bytes, filename, mimeType: 'application/pdf' },
      args.delivery ?? 'file',
      `nula://invoices/${args.invoice_id}/pdf?lang=${lang}`,
    );
    return ok(out.summary, { invoice_id: args.invoice_id, language: lang, ...out.data }, out.blocks);
  },
});

export const emailInvoice = defineTool({
  name: 'nula_email_invoice',
  toolset: 'invoices',
  title: 'E-mail an invoice',
  description:
    'E-mail an invoice to a recipient from nula.bg. This contacts a third party and cannot be undone: ' +
    'confirm the recipient address and language with the user first.',
  kind: 'write',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  input: z.object({
    invoice_id: idParam('invoice'),
    to: z.string().regex(EMAIL_PATTERN, 'Invalid e-mail address').describe('Recipient e-mail'),
    language,
    attach_as: z.enum(['file', 'link']).optional().describe('Attach the PDF (default) or send a link'),
    include_attachments: z.boolean().optional().describe('Also send files attached to the invoice'),
    note: z.string().max(2000).optional().describe('Message text in the e-mail'),
  }),
  async run(args, call) {
    const lang = args.language ?? call.env.config.defaultLanguage;
    const confirmation = confirmAction(
      call,
      `Изпращане на фактура id ${args.invoice_id} до ${args.to} (${lang === 'en' ? 'английски' : 'български'})?`,
      { always: true },
    );
    if (confirmation.status !== 'confirmed') return confirmation.result;
    await call.client.get(`/api/v1/invoice/${args.invoice_id}/email`, {
      query: {
        email: args.to,
        send_in_english: lang === 'en' ? 1 : 0,
        send_attached_files: args.include_attachments ? 1 : 0,
        attach_type: args.attach_as ?? 'file',
        note: args.note,
      },
      retry: false, // side effect: never resend automatically
      signal: call.ctx.mcpReq.signal,
    });
    return ok(`Invoice ${args.invoice_id} was e-mailed to ${args.to}.`, {
      invoice_id: args.invoice_id,
      to: args.to,
      language: lang,
    });
  },
});

export const deleteLastInvoice = defineTool({
  name: 'nula_delete_last_invoice',
  toolset: 'invoices',
  title: 'Delete the most recent invoice',
  description:
    'Delete the MOST RECENT invoice. nula.bg deletes only the last invoice in the sequence (the endpoint takes no ' +
    'parameters) and refuses invoices already posted to accounting (осчетоводена) with HTTP 403. In companies where ' +
    'accounting posts every invoice automatically, deletion via the API is not possible at all — issue a credit note ' +
    'instead. Pass the number you expect to delete; the call is refused if a different invoice is last.',
  kind: 'write',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  input: z.object({
    expected_number: docNumber.describe('Number of the invoice you intend to delete'),
    reason: z.string().max(500).optional(),
  }),
  async run(args, call) {
    const { client, ctx } = call;
    const expected = padDocNumber(args.expected_number);
    const body = await client.get('/api/v1/getNextInvoiceNumber', { query: { type: 1 }, signal: ctx.mcpReq.signal });
    const data = unwrap(body);
    const next = isObj(data)
      ? pickStr(data, 'number', 'next_number', 'invoice_number')
      : typeof data === 'string' || typeof data === 'number'
        ? String(data)
        : undefined;
    if (!next || !/^\d+$/.test(next))
      return fail('Could not determine the last invoice number from nula.bg. Nothing was deleted.');
    const last = padDocNumber(String(Number(next) - 1));
    if (last !== expected) {
      return fail(
        `The last invoice is №${last}, not №${expected}. nula.bg can only delete the last one. Nothing was deleted.`,
      );
    }
    const [existing] = await findInvoicesByNumber(client, expected, ctx.mcpReq.signal);
    if (!existing) return fail(`Invoice №${expected} was not found. Nothing was deleted.`);
    const inv = normalizeInvoice(existing);

    // Verified 2026-09-26: nula.bg answers 403 (with an empty message) for invoices already posted to accounting.
    const stub = await client
      .get('/api/v1/getInvoicesByNumber', { query: { number: expected }, signal: ctx.mcpReq.signal })
      .then((body) => extractList(body).items[0])
      .catch(() => undefined); // the guard is best-effort: a failing lookup must not block a legitimate delete
    if (stub && pickBool(stub, 'has_accounting') === true) {
      return fail(
        `Invoice №${expected} is already posted to accounting (осчетоводена), and nula.bg refuses to delete such ` +
          'invoices (HTTP 403). Remove the accounting entry in the nula.bg web app first, or issue a credit note ' +
          '(document_type "credit_note") instead. Nothing was deleted.',
      );
    }

    const confirmation = confirmAction(
      call,
      `ИЗТРИВАНЕ на фактура №${expected} (${summaryLine(inv)})? Действието е необратимо.`,
      {
        always: true,
      },
    );
    if (confirmation.status !== 'confirmed') return confirmation.result;
    await client.delete('/api/v1/deleteInvoice', { signal: ctx.mcpReq.signal });
    return ok(`Deleted invoice №${expected}.`, { deleted_number: expected, invoice: inv, reason: args.reason });
  },
});
