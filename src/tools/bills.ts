import { z } from 'zod';
import { fileInputSchema, loadFile, toDataUri } from '../files.ts';
import { resolveRange, toDateRange } from '../mappers/dates.ts';
import { BILL_FIELD_MAP, buildBillPayload } from '../mappers/documents.ts';
import { BILL_PAYMENT_METHODS, TAX_CREDIT_TYPES } from '../mappers/enums.ts';
import { formatMoney } from '../mappers/money.ts';
import { NulaApiError } from '../nula/client.ts';
import { extractList, isObj, normalizeBill, normalizeLines, pickNum, pickStr, unwrap } from '../nula/normalize.ts';
import { PROTOCOL_REASONS } from '../nula/reference-data.ts';
import { confirmAction } from './confirm.ts';
import { applyLimit, defineTool, fail, fitItems, ok } from './define.ts';
import {
  categories,
  counterpartySchema,
  docNumber,
  idParam,
  isoDate,
  page,
  responseFormat,
  vatRate,
  yearMonth,
} from './schemas.ts';

function billLine(b: Record<string, unknown>): string {
  const supplier = isObj(b.supplier) ? (b.supplier.name as string | undefined) : undefined;
  return [
    `№${b.number ?? '?'}`,
    b.issue_date,
    supplier,
    formatMoney(b.total as number | undefined, (b.currency as string) ?? 'EUR'),
  ]
    .filter(Boolean)
    .join(' · ');
}

export const searchBills = defineTool({
  name: 'nula_search_bills',
  toolset: 'bills',
  title: 'Search purchase bills',
  description:
    'Find purchase documents (покупки, входящи фактури от доставчици) by period, supplier or number. ' +
    'Pass bill_id to get one bill in full with its lines.',
  kind: 'read',
  input: z.object({
    bill_id: idParam('bill').optional().describe('Get this bill in full, with lines'),
    number: docNumber.optional().describe("Supplier's document number"),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    supplier_name: z.string().optional(),
    supplier_eik: z.string().optional(),
    supplier_vat_number: z.string().optional(),
    page,
    limit: z.number().int().min(1).max(100).optional().describe('Max records to return from the page (default 25)'),
    response_format: responseFormat,
  }),
  async run(args, { client, ctx }) {
    const signal = ctx.mcpReq.signal;
    if (args.bill_id) {
      const body = await client
        .get(`/api/v1/ocr/bill/${args.bill_id}`, { signal })
        .catch((err) => (err instanceof NulaApiError && err.status === 404 ? undefined : Promise.reject(err)));
      if (!body) {
        // /ocr/bill/{id} only knows OCR-created bills, so look the id up in the list, which also carries the lines.
        for (let p = 1; p <= 5; p++) {
          const list = extractList(await client.get('/api/v1/bills', { query: { page: p }, signal }), p);
          const found = list.items.find((b) => pickNum(b, 'id') === args.bill_id);
          if (found) return ok(billLine(normalizeBill(found)), normalizeBill(found, true));
          if (list.page.has_more === false) break;
        }
        return fail(
          `Bill ${args.bill_id} was not found: /ocr/bill/{id} answers 404 for bills that were not created by OCR, and ` +
            'the id is not among the 500 most recent bills. Search by number or period with nula_search_bills instead.',
        );
      }
      const data = unwrap(body);
      const rec = isObj(data) ? { ...data } : {};
      // This endpoint returns the lines next to `data`, at the top level of the envelope.
      if (isObj(body) && Array.isArray(body.items) && !rec.items) rec.items = body.items;
      const bill = normalizeBill({ id: args.bill_id, ...rec }, true);
      bill.lines ??= normalizeLines(rec);
      return ok(billLine(bill), bill);
    }
    const range = resolveRange(args.date_from, args.date_to);
    const body = await client.get('/api/v1/bills', {
      query: {
        daterange: range ? toDateRange(range.from, range.to) : undefined,
        page: args.page,
        name: args.supplier_name,
        identifier: args.supplier_eik,
        vat_number: args.supplier_vat_number,
        number: args.number,
      },
      signal,
    });
    const { items, page: pg } = extractList(body, args.page ?? 1);
    const { items: bills, note } = applyLimit(
      items.map((b) => normalizeBill(b, args.response_format === 'detailed')),
      args.limit,
    );
    return ok(
      [
        `${bills.length} bills${pg.has_more ? ' (more pages available)' : ''}.${note ? ` ${note}` : ''}`,
        ...bills.map(billLine),
      ].join('\n'),
      fitItems({ items: bills, ...pg, note }, 'Narrow the period or filter by supplier.'),
    );
  },
});

const billLineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  sku: z.string().optional(),
  quantity: z.number().positive(),
  unit_price: z.number(),
  unit: z.string().min(1).describe('Unit of measure (мярка), e.g. "бр.", "кг", "час"'),
  expense_account: z
    .number()
    .int()
    .describe('Expense account (разходна сметка), e.g. 602 services, 601 materials, 304 goods'),
  revenue_account: z.number().int().optional().describe('Revenue account if the item is resold, e.g. 702'),
  track_inventory: z.boolean().describe('Track stock quantity for this item (склад)'),
  tax_credit: z
    .enum(Object.keys(TAX_CREDIT_TYPES) as ['full', 'partial', 'none', 'tro'])
    .optional()
    .describe('Данъчен кредит: full = ПДК, partial = ЧДК, none = БДК, tro = ТРО'),
  vat_sum: z.number().optional().describe('VAT AMOUNT for this line (not the rate); only with tax_credit'),
  match_by_sku_only: z.boolean().optional().describe('Match existing items by sku only, not by name'),
});

export const createBill = defineTool({
  name: 'nula_create_bill',
  toolset: 'bills',
  title: 'Record a purchase bill',
  description:
    'Record a purchase document (покупка / входяща фактура) from a supplier, optionally with a protocol under ' +
    'чл.117 ЗДДС. Call with preview_only: true first and confirm with the user. For scanned documents prefer ' +
    'nula_ocr_upload, which creates bills automatically.',
  kind: 'write',
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  fieldMap: BILL_FIELD_MAP,
  input: z.object({
    supplier: counterpartySchema.describe('Supplier (доставчик)'),
    number: docNumber.describe("The supplier's document number"),
    document_type: z.enum(['invoice', 'proforma', 'debit_note', 'credit_note', 'protocol']).optional(),
    issue_date: isoDate.describe('Дата на издаване'),
    tax_event_date: isoDate.describe('Дата на данъчно събитие'),
    due_date: isoDate.optional(),
    vat_period: yearMonth.optional().describe('VAT period to record it in (YYYY-MM); default from issue date'),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .optional(),
    prices_include_vat: z.boolean(),
    vat_rate: vatRate,
    payment_method: z.enum(Object.keys(BILL_PAYMENT_METHODS) as ['bank_transfer', 'cash', 'card']),
    iban: z.string().optional().describe("Supplier's IBAN for bank payment"),
    note: z.string().max(2000).optional(),
    categories: categories.optional(),
    lines: z.array(billLineSchema).min(1).max(200),
    protocol: z
      .object({
        number: docNumber.optional().describe('Protocol number (default: next free)'),
        date: isoDate.optional().describe('Protocol date (default: tax event date)'),
        reason: z.number().int().min(1).max(32).describe('Reason code 1–32, see nula://reference/protocol-reasons'),
      })
      .optional()
      .describe('Protocol under чл.117 ЗДДС (e.g. EU acquisitions/ВОП, services from abroad)'),
    attachment: fileInputSchema.optional(),
    preview_only: z.boolean().optional(),
  }),
  async run(args, call) {
    const { client, ctx, env } = call;
    const callback = env.config.billCallbackUrl ?? `${env.config.baseUrl}/`;
    const built = buildBillPayload(args, env.config, callback);
    if (args.protocol && !PROTOCOL_REASONS[args.protocol.reason]) built.errors.push('protocol.reason must be 1–32');
    if (built.errors.length) return fail(`Cannot create the bill:\n- ${built.errors.join('\n- ')}`);
    const t = built.totals;
    if (args.preview_only) {
      return ok(
        `PREVIEW (nothing created): bill №${built.payload.number} from ${args.supplier.name}: net ${formatMoney(t.net, t.currency)}, ` +
          `VAT ${formatMoney(t.vat, t.currency)}, total ${formatMoney(t.total, t.currency)}. Ask the user to confirm.`,
        { preview: true, totals: t, warnings: built.warnings, payload: { ...built.payload, callback_url: undefined } },
      );
    }
    const confirmation = confirmAction(
      call,
      `Въвеждане на покупка №${built.payload.number} от ${args.supplier.name} за ${formatMoney(t.total, t.currency)}?`,
    );
    if (confirmation.status !== 'confirmed') return confirmation.result;
    if (args.attachment) {
      built.payload.file = toDataUri(
        await loadFile(args.attachment, env.config, { fetch: env.fetch, signal: ctx.mcpReq.signal }),
      );
    }
    const body = await client.post('/api/v1/createBill', { body: built.payload, signal: ctx.mcpReq.signal });
    const data = unwrap(body);
    const id = isObj(data) ? pickNum(data, 'id', 'bill_id') : undefined;
    const protocolNumber = isObj(data) ? pickStr(data, 'protocol_number') : undefined;
    return ok(
      id
        ? `Created bill №${built.payload.number} (id ${id})${protocolNumber ? `, protocol №${protocolNumber}` : ''}.`
        : `nula.bg accepted bill №${built.payload.number} for processing. Check it with nula_search_bills in a moment.`,
      { id, number: built.payload.number, protocol_number: protocolNumber, totals: t, warnings: built.warnings },
    );
  },
});

export const updateBillCategories = defineTool({
  name: 'nula_update_bill_categories',
  toolset: 'bills',
  title: 'Set bill categories',
  description: 'Replace the categories (категории/тагове) of a purchase bill.',
  kind: 'write',
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ bill_id: idParam('bill'), categories }),
  async run(args, { client, ctx }) {
    await client.post(`/api/v1/bill/${args.bill_id}/category`, {
      body: { tags: args.categories },
      signal: ctx.mcpReq.signal,
    });
    return ok(`Bill ${args.bill_id} categories set to: ${args.categories.join(', ')}.`, {
      id: args.bill_id,
      categories: args.categories,
    });
  },
});
