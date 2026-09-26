/**
 * Computed reports over the public REST API. They page through data within a request budget and always
 * report `coverage`, so a partial answer is never presented as complete.
 */
import { z } from 'zod';
import { addDays, daysBetween, toDateRange, todaySofia } from '../mappers/dates.ts';
import { formatMoney, round2 } from '../mappers/money.ts';
import type { NulaClient, Query } from '../nula/client.ts';
import {
  extractList,
  isObj,
  normalizeBill,
  normalizeInvoice,
  normalizeTransaction,
  type Obj,
} from '../nula/normalize.ts';
import { defineTool, fail, fitItems, ok } from './define.ts';
import { idParam, isoDate, yearMonth } from './schemas.ts';

const MAX_PAGES = 30;

interface Coverage {
  pages_fetched: number;
  complete: boolean;
}

export async function fetchAll(
  client: NulaClient,
  path: string,
  query: Query,
  signal?: AbortSignal,
  maxPages = MAX_PAGES,
): Promise<{ items: Obj[]; coverage: Coverage }> {
  const all: Obj[] = [];
  let pageNo = 1;
  let complete = false;
  let lastFirstId: unknown;
  for (; pageNo <= maxPages; pageNo++) {
    const { items, page } = extractList(await client.get(path, { query: { ...query, page: pageNo }, signal }), pageNo);
    // Guard against APIs that ignore `page` and keep returning the first page.
    if (items.length && items[0]?.id !== undefined && items[0]?.id === lastFirstId) {
      complete = true;
      break;
    }
    lastFirstId = items[0]?.id;
    all.push(...items);
    // Without pagination metadata keep going until an empty or repeated page.
    if (items.length === 0 || page.has_more === false) {
      complete = true;
      break;
    }
  }
  return { items: all, coverage: { pages_fetched: Math.min(pageNo, maxPages), complete } };
}

const outstanding = (inv: Obj) => round2(((inv.total as number) ?? 0) - ((inv.paid_amount as number) ?? 0));

export const receivablesReport = defineTool({
  name: 'nula_receivables_report',
  toolset: 'insights',
  title: 'Receivables and overdue invoices',
  description:
    'Unpaid and overdue sales invoices (вземания, просрочени фактури) as of a date, grouped by customer with ' +
    'aging buckets (0–30 / 31–60 / 61–90 / 90+ days overdue). Read-only.',
  kind: 'read',
  input: z.object({
    as_of: isoDate.optional().describe('Reference date (default today)'),
    date_from: isoDate.optional().describe('Only invoices issued from this date (default: 12 months before as_of)'),
    customer_eik: z.string().optional(),
    min_days_overdue: z.number().int().min(0).optional().describe('Only invoices at least this many days overdue'),
  }),
  async run(args, { client, ctx }) {
    const asOf = args.as_of ?? todaySofia();
    const from = args.date_from ?? addDays(asOf, -365);
    const { items, coverage } = await fetchAll(
      client,
      '/api/v1/getInvoices',
      { daterange: toDateRange(from, asOf), identifier: args.customer_eik },
      ctx.mcpReq.signal,
    );
    const invoices = items.map((i) => normalizeInvoice(i)).filter((i) => i.document_type !== 'proforma');
    const unknownStatus = invoices.filter((i) => i.is_paid === undefined).length;
    const unpaid = invoices
      .filter((i) => i.is_paid === false && outstanding(i) > 0.009)
      .map((i): Obj & { outstanding: number; days_overdue: number } => {
        const overdue = i.due_date ? daysBetween(i.due_date as string, asOf) : 0;
        return { ...i, outstanding: outstanding(i), days_overdue: Math.max(overdue, 0) };
      })
      .filter((i) => i.days_overdue >= (args.min_days_overdue ?? 0));

    const bucket = (d: number) =>
      d === 0 ? 'current' : d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+';
    type Entry = { customer: unknown; total: number; invoices: Obj[]; aging: Record<string, number> };
    const byCustomer = new Map<string, Entry>();
    for (const inv of unpaid) {
      const c = isObj(inv.customer) ? inv.customer : {};
      const key = String(c.eik ?? c.vat_number ?? c.name ?? 'unknown');
      const entry: Entry = byCustomer.get(key) ?? { customer: c, total: 0, invoices: [], aging: {} };
      entry.total = round2(entry.total + inv.outstanding);
      const b = bucket(inv.days_overdue);
      entry.aging[b] = round2((entry.aging[b] ?? 0) + inv.outstanding);
      entry.invoices.push({
        id: inv.id,
        number: inv.number,
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        outstanding: inv.outstanding,
        currency: inv.currency,
        days_overdue: inv.days_overdue,
      });
      byCustomer.set(key, entry);
    }
    const customers = [...byCustomer.values()].sort((a, b) => b.total - a.total);
    const totalOutstanding = round2(customers.reduce((s, c) => s + c.total, 0));
    const aging: Record<string, number> = {};
    for (const c of customers) for (const [k, v] of Object.entries(c.aging)) aging[k] = round2((aging[k] ?? 0) + v);

    const notes: string[] = [];
    if (!coverage.complete)
      notes.push(`Only the first ${coverage.pages_fetched} pages were read; totals may be incomplete.`);
    if (unknownStatus)
      notes.push(`${unknownStatus} invoices have no paid/unpaid status in the API response and were skipped.`);
    return ok(
      `Receivables as of ${asOf}: ${formatMoney(totalOutstanding)} outstanding on ${unpaid.length} invoices from ${customers.length} customers. ${notes.join(' ')}`,
      fitItems(
        { items: customers, as_of: asOf, total_outstanding: totalOutstanding, aging, coverage, notes },
        'Filter by customer_eik or min_days_overdue.',
      ),
    );
  },
});

export const periodSummary = defineTool({
  name: 'nula_period_summary',
  toolset: 'insights',
  title: 'Sales and purchases summary',
  description:
    'Summary for a month or period: number and totals of sales and purchases, VAT charged vs VAT on purchases, ' +
    'top customers and suppliers. Indicative only: this is NOT the official VAT return (справка-декларация).',
  kind: 'read',
  input: z.object({
    month: yearMonth.optional().describe('Month as YYYY-MM'),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
  }),
  async run(args, { client, ctx }) {
    let from = args.date_from;
    let to = args.date_to;
    if (args.month) {
      from = `${args.month}-01`;
      to = addDays(`${addDays(`${args.month}-28`, 4).slice(0, 7)}-01`, -1);
    }
    if (!from || !to) return fail('Give month (YYYY-MM) or both date_from and date_to.');
    const signal = ctx.mcpReq.signal;
    const range = toDateRange(from, to);
    const [sales, purchases] = await Promise.all([
      fetchAll(client, '/api/v1/getInvoices', { daterange: range }, signal),
      fetchAll(client, '/api/v1/bills', { daterange: range }, signal),
    ]);
    const sign = (d: Obj) => (d.document_type === 'credit_note' ? -1 : 1);
    const agg = (docs: Obj[]) => ({
      count: docs.length,
      net: round2(docs.reduce((s, d) => s + sign(d) * ((d.net as number) ?? 0), 0)),
      vat: round2(docs.reduce((s, d) => s + sign(d) * ((d.vat as number) ?? 0), 0)),
      total: round2(docs.reduce((s, d) => s + sign(d) * ((d.total as number) ?? 0), 0)),
    });
    const top = (docs: Obj[], party: 'customer' | 'supplier') => {
      const m = new Map<string, number>();
      for (const d of docs) {
        const p = isObj(d[party]) ? (d[party] as Obj) : {};
        const name = String(p.name ?? p.eik ?? 'unknown');
        m.set(name, round2((m.get(name) ?? 0) + sign(d) * ((d.total as number) ?? 0)));
      }
      return [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, total]) => ({ name, total }));
    };
    const s = sales.items.map((i) => normalizeInvoice(i)).filter((i) => i.document_type !== 'proforma');
    const p = purchases.items.map((b) => normalizeBill(b));
    const sa = agg(s);
    const pa = agg(p);
    const result = {
      period: { from, to },
      sales: { ...sa, top_customers: top(s, 'customer') },
      purchases: { ...pa, top_suppliers: top(p, 'supplier') },
      vat_indicative: { charged: sa.vat, on_purchases: pa.vat, difference: round2(sa.vat - pa.vat) },
      coverage: { sales: sales.coverage, purchases: purchases.coverage },
      disclaimer:
        'Indicative figures from document totals; not a VAT return. Tax credit rules (ПДК/ЧДК/БДК) are not applied.',
    };
    return ok(
      `${from}…${to}: sales ${sa.count} docs, ${formatMoney(sa.total)}; purchases ${pa.count} docs, ${formatMoney(pa.total)}; ` +
        `VAT charged ${formatMoney(sa.vat)} vs on purchases ${formatMoney(pa.vat)} (indicative).`,
      result,
    );
  },
});

const digits = (s: string) => s.replace(/^0+/, '');

export const matchBankTransactions = defineTool({
  name: 'nula_match_bank_transactions',
  toolset: 'insights',
  title: 'Suggest bank ↔ invoice matches',
  description:
    'Suggest which incoming bank transactions pay which unpaid sales invoices (by amount, invoice number in the ' +
    'payment reason, customer name/EIK). Only suggestions: nothing is changed. Mark invoices paid with ' +
    'nula_update_invoice_metadata after the user agrees.',
  kind: 'read',
  input: z.object({
    bank_account_id: idParam('bank account'),
    date_from: isoDate,
    date_to: isoDate,
  }),
  async run(args, { client, ctx }) {
    const signal = ctx.mcpReq.signal;
    const [txRes, invRes] = await Promise.all([
      fetchAll(
        client,
        `/api/v1/transactions/${args.bank_account_id}/getTransactions`,
        { from: args.date_from, to: args.date_to },
        signal,
      ),
      fetchAll(
        client,
        '/api/v1/getInvoices',
        { daterange: toDateRange(addDays(args.date_from, -365), args.date_to) },
        signal,
      ),
    ]);
    const incoming = txRes.items.map(normalizeTransaction).filter((t) => t.direction === 'in');
    const unpaid = invRes.items
      .map((i) => normalizeInvoice(i))
      .filter((i) => i.is_paid !== true && i.document_type !== 'proforma' && i.document_type !== 'credit_note')
      .map((i): Obj & { outstanding: number } => ({ ...i, outstanding: outstanding(i) }));

    const suggestions = incoming.map((tx) => {
      const text = `${tx.description ?? ''} ${tx.reference ?? ''} ${tx.counterparty ?? ''}`.toLowerCase();
      const scored = unpaid
        .map((inv) => {
          let score = 0;
          const reasons: string[] = [];
          if (typeof tx.amount === 'number' && Math.abs(tx.amount - inv.outstanding) < 0.01) {
            score += 50;
            reasons.push('amount');
          }
          const num = typeof inv.number === 'string' ? digits(inv.number) : '';
          if (num.length >= 2 && new RegExp(`(^|\\D)0*${num}(\\D|$)`).test(text)) {
            score += 40;
            reasons.push('invoice number in reason');
          }
          const c = isObj(inv.customer) ? inv.customer : {};
          if (typeof c.eik === 'string' && text.includes(c.eik)) {
            score += 30;
            reasons.push('EIK');
          }
          const name =
            typeof c.name === 'string'
              ? c.name
                  .toLowerCase()
                  .replace(/\b(оод|еоод|ад|ет|ltd|llc|gmbh)\b/g, '')
                  .trim()
              : '';
          if (name.length >= 4 && text.includes(name)) {
            score += 20;
            reasons.push('customer name');
          }
          return {
            invoice: {
              id: inv.id,
              number: inv.number,
              customer: c.name,
              outstanding: inv.outstanding,
              due_date: inv.due_date,
            },
            score,
            reasons,
          };
        })
        .filter((s) => s.score >= 50)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      return {
        transaction: {
          id: tx.id,
          date: tx.date,
          amount: tx.amount,
          counterparty: tx.counterparty,
          description: tx.description,
        },
        candidates: scored.map((s) => ({
          ...s.invoice,
          confidence: s.score >= 90 ? 'high' : s.score >= 70 ? 'medium' : 'low',
          matched_on: s.reasons,
        })),
      };
    });
    const matched = suggestions.filter((s) => s.candidates.length > 0);
    const coverage = { transactions: txRes.coverage, invoices: invRes.coverage };
    return ok(
      `${incoming.length} incoming transactions, ${matched.length} with likely matches among ${unpaid.length} unpaid invoices. Confirm with the user before marking anything paid.`,
      fitItems(
        { items: matched, unmatched_count: incoming.length - matched.length, coverage },
        'Use a shorter period.',
      ),
    );
  },
});
