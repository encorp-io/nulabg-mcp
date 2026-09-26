/**
 * MCP arguments → nula.bg payloads for createInvoice / editInvoice / createBill,
 * with local validation and an approximate totals preview.
 */
import type { Config } from '../config.ts';
import { ZERO_VAT_REASONS } from '../nula/reference-data.ts';
import { daysBetween, isoToBg, todaySofia } from './dates.ts';
import {
  BILL_DOCUMENT_TYPES,
  BILL_PAYMENT_METHODS,
  type BillDocumentType,
  INVOICE_DOCUMENT_TYPES,
  INVOICE_PAYMENT_METHODS,
  type InvoiceDocumentType,
  type InvoicePaymentMethod,
  LINE_KINDS,
  type LineKind,
  TAX_CREDIT_TYPES,
} from './enums.ts';
import {
  isBulgarianVat,
  isValidEik,
  isValidIban,
  NO_VAT_NUMBER,
  normalizeIban,
  normalizeVat,
  padDocNumber,
} from './identifiers.ts';
import { round2 } from './money.ts';

export interface CounterpartyInput {
  name: string;
  eik?: string;
  vat_number?: string;
  no_vat_number?: boolean;
  is_bulgarian?: boolean;
  address?: string;
  post_code?: string;
  city?: string;
  country?: string;
}

export interface InvoiceLineInput {
  name: string;
  description?: string;
  sku?: string;
  quantity: number;
  unit_price: number;
  kind: LineKind;
  vat_rate?: 20 | 9 | 0;
  existing_item_only?: boolean;
}

export interface InvoiceInput {
  customer: CounterpartyInput;
  document_type?: InvoiceDocumentType;
  number?: string;
  issue_date?: string;
  tax_event_date?: string;
  due_date?: string;
  currency?: string;
  exchange_rate?: number;
  prices_include_vat: boolean;
  vat_rate?: 20 | 9 | 0;
  zero_vat_reason?: number;
  payment_method: InvoicePaymentMethod;
  iban?: string;
  paid_amount?: number;
  note?: string;
  categories?: string[];
  oss_country?: string;
  lines: InvoiceLineInput[];
}

export interface BillLineInput {
  name: string;
  description?: string;
  sku?: string;
  quantity: number;
  unit_price: number;
  unit: string;
  expense_account: number;
  revenue_account?: number;
  track_inventory: boolean;
  tax_credit?: keyof typeof TAX_CREDIT_TYPES;
  vat_sum?: number;
  match_by_sku_only?: boolean;
}

export interface BillInput {
  supplier: CounterpartyInput;
  number: string;
  document_type?: BillDocumentType;
  issue_date: string;
  tax_event_date: string;
  due_date?: string;
  vat_period?: string;
  currency?: string;
  prices_include_vat: boolean;
  vat_rate: 20 | 9 | 0;
  payment_method: keyof typeof BILL_PAYMENT_METHODS;
  iban?: string;
  note?: string;
  categories?: string[];
  lines: BillLineInput[];
  protocol?: { number?: string; date?: string; reason: number };
}

export interface Totals {
  currency: string;
  by_rate: Array<{ vat_rate: number; net: number; vat: number; gross: number }>;
  net: number;
  vat: number;
  total: number;
}

export interface Built<P> {
  payload: P;
  errors: string[];
  warnings: string[];
  totals: Totals;
}

type Payload = Record<string, unknown>;

/** Validates and maps a counterparty; mutates `errors`/`warnings`. */
function mapCounterparty(party: CounterpartyInput, label: string, errors: string[], warnings: string[]): Payload {
  const vat = party.vat_number ? normalizeVat(party.vat_number) : undefined;
  const isBg = party.is_bulgarian ?? (party.eik ? true : vat ? isBulgarianVat(vat) : undefined);
  const out: Payload = { recipient_company_name: party.name.trim() };

  if (isBg === undefined) {
    errors.push(`${label}: give eik (Bulgarian company) or vat_number (foreign company). Use nula_lookup_company.`);
    return out;
  }
  out.bulgarian_recipient = isBg ? 1 : 0;
  if (isBg) {
    if (!party.eik) errors.push(`${label}.eik is required for a Bulgarian counterparty`);
    else {
      out.identifier = party.eik;
      if (!isValidEik(party.eik)) warnings.push(`${label}.eik ${party.eik} fails the EIK checksum; double-check it`);
    }
    if (vat) out.recipient_vat = vat;
  } else if (vat) {
    out.recipient_vat = vat;
  } else if (party.no_vat_number) {
    out.recipient_vat = NO_VAT_NUMBER;
  } else {
    errors.push(`${label}.vat_number is required for a foreign counterparty (or set no_vat_number: true)`);
  }
  return out;
}

function computeTotals(
  lines: Array<{ quantity: number; unit_price: number; rate: number }>,
  pricesIncludeVat: boolean,
  currency: string,
): Totals {
  const byRate = new Map<number, number>();
  for (const l of lines) byRate.set(l.rate, (byRate.get(l.rate) ?? 0) + l.quantity * l.unit_price);
  const rows = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, amount]) => {
      if (pricesIncludeVat) {
        const gross = round2(amount);
        const net = round2(gross / (1 + rate / 100));
        return { vat_rate: rate, net, vat: round2(gross - net), gross };
      }
      const net = round2(amount);
      const vat = round2((net * rate) / 100);
      return { vat_rate: rate, net, vat, gross: round2(net + vat) };
    });
  const sum = (k: 'net' | 'vat' | 'gross') => round2(rows.reduce((s, r) => s + r[k], 0));
  return { currency, by_rate: rows, net: sum('net'), vat: sum('vat'), total: sum('gross') };
}

function checkDates(issue: string, taxEvent: string, due: string | undefined, errors: string[], warnings: string[]) {
  if (due && daysBetween(issue, due) < 0) errors.push('due_date cannot be before issue_date');
  const gap = daysBetween(taxEvent, issue);
  if (gap > 5) warnings.push(`issue_date is ${gap} days after tax_event_date; ЗДДС requires invoicing within 5 days`);
  if (gap < 0 && -gap > 5) warnings.push(`tax_event_date is ${-gap} days after issue_date; check the dates`);
}

export function buildInvoicePayload(input: InvoiceInput, config: Config, today = todaySofia()): Built<Payload> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const payload: Payload = mapCounterparty(input.customer, 'customer', errors, warnings);

  for (const key of ['address', 'post_code', 'city', 'country'] as const) {
    if (input.customer[key]) payload[`recipient_${key}`] = input.customer[key];
  }

  const documentType = input.document_type ?? 'invoice';
  payload.type = INVOICE_DOCUMENT_TYPES[documentType];
  if (input.number) payload.number = padDocNumber(input.number);

  const issue = input.issue_date ?? today;
  const taxEvent = input.tax_event_date ?? issue;
  checkDates(issue, taxEvent, input.due_date, errors, warnings);
  payload.created_at = isoToBg(issue);
  payload.invoiced_at = isoToBg(taxEvent);
  if (input.due_date) payload.due_at = isoToBg(input.due_date);

  const currency = (input.currency ?? config.defaultCurrency).toUpperCase();
  payload.currency_code = currency;
  if (currency === 'BGN' && issue >= '2026-01-01') {
    warnings.push('Bulgaria uses EUR since 2026-01-01; invoices dated 2026 or later should normally be in EUR');
  }
  if (input.exchange_rate !== undefined) payload.exchange_rate = input.exchange_rate;

  payload.payment_method = INVOICE_PAYMENT_METHODS[input.payment_method];
  payload.price_type = input.prices_include_vat ? 1 : 0;

  const baseRate = input.vat_rate ?? 20;
  const rates = input.lines.map((l) => l.vat_rate ?? baseRate);
  const mixed = new Set(rates).size > 1;
  payload.vat_amount = baseRate;
  payload.different_vats = mixed ? 1 : 0;

  if (rates.includes(0)) {
    if (input.zero_vat_reason === undefined) {
      errors.push('zero_vat_reason is required when a VAT rate is 0% (see resource nula://reference/zero-vat-reasons)');
    } else if (!ZERO_VAT_REASONS[input.zero_vat_reason]) {
      errors.push(`zero_vat_reason ${input.zero_vat_reason} is not a valid code (1–57)`);
    } else payload.no_vat_reason = input.zero_vat_reason;
  } else if (input.zero_vat_reason !== undefined) {
    warnings.push('zero_vat_reason is ignored because no line has a 0% VAT rate');
  }

  if (input.iban) {
    const iban = normalizeIban(input.iban);
    if (!isValidIban(iban)) errors.push(`iban ${input.iban} is not a valid IBAN`);
    payload.IBAN = iban;
  }
  if (input.paid_amount !== undefined) payload.paid_amount = round2(input.paid_amount);
  if (input.note) payload.note = input.note;
  if (input.oss_country) payload.oss_country = input.oss_country.toUpperCase();

  const tags = input.categories?.length
    ? input.categories
    : config.defaultInvoiceCategory
      ? [config.defaultInvoiceCategory]
      : [];
  if (tags.length === 0) {
    errors.push('categories is required by nula.bg (at least one), or set NULA_DEFAULT_INVOICE_CATEGORY');
  }
  payload.tags = tags;

  if (input.lines.length === 0) errors.push('lines must contain at least one line');
  payload.items = input.lines.map((line, i) => {
    if (!Number.isInteger(line.quantity)) {
      warnings.push(`lines[${i}].quantity ${line.quantity} is fractional; the nula.bg spec types it as an integer`);
    }
    const item: Payload = {
      name: line.name,
      description: line.description?.trim() || line.name,
      item_type: LINE_KINDS[line.kind],
      quantity: line.quantity,
      price: line.unit_price,
    };
    if (line.sku) item.sku = line.sku;
    if (line.existing_item_only) item.only_search = 1;
    if (mixed) item.vat_amount = line.vat_rate ?? baseRate;
    return item;
  });

  const totals = computeTotals(
    input.lines.map((l, i) => ({ quantity: l.quantity, unit_price: l.unit_price, rate: rates[i]! })),
    input.prices_include_vat,
    currency,
  );
  if (input.paid_amount !== undefined && input.paid_amount > totals.total + 0.005) {
    warnings.push(`paid_amount ${input.paid_amount} exceeds the invoice total ${totals.total}`);
  }
  return { payload, errors, warnings, totals };
}

export const INVOICE_FIELD_MAP: Record<string, string> = {
  identifier: 'customer.eik',
  recipient_vat: 'customer.vat_number',
  recipient_company_name: 'customer.name',
  bulgarian_recipient: 'customer.is_bulgarian',
  recipient_address: 'customer.address',
  recipient_post_code: 'customer.post_code',
  recipient_city: 'customer.city',
  recipient_country: 'customer.country',
  type: 'document_type',
  invoiced_at: 'tax_event_date',
  created_at: 'issue_date',
  due_at: 'due_date',
  vat_amount: 'vat_rate',
  currency_code: 'currency',
  IBAN: 'iban',
  price_type: 'prices_include_vat',
  no_vat_reason: 'zero_vat_reason',
  different_vats: 'lines[].vat_rate',
  tags: 'categories',
  file: 'attachment',
  items: 'lines',
  'items[].price': 'lines[].unit_price',
  'items[].item_type': 'lines[].kind',
  'items[].only_search': 'lines[].existing_item_only',
  'items[].vat_amount': 'lines[].vat_rate',
};

export function buildBillPayload(input: BillInput, config: Config, callbackUrl: string): Built<Payload> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const payload: Payload = mapCounterparty(input.supplier, 'supplier', errors, warnings);
  payload.callback_url = callbackUrl;
  payload.number = padDocNumber(input.number);
  payload.type = BILL_DOCUMENT_TYPES[input.document_type ?? 'invoice'];

  checkDates(input.issue_date, input.tax_event_date, input.due_date, errors, warnings);
  payload.created_at = isoToBg(input.issue_date);
  payload.billed_at = isoToBg(input.tax_event_date);
  if (input.due_date) payload.due_at = isoToBg(input.due_date);
  if (input.vat_period) payload.vat_period = input.vat_period;

  const currency = (input.currency ?? config.defaultCurrency).toUpperCase();
  payload.currency_code = currency;
  payload.payment_method = BILL_PAYMENT_METHODS[input.payment_method];
  payload.price_type = input.prices_include_vat ? 1 : 0;
  payload.vat_amount = input.vat_rate;

  const mixed = input.lines.some((l) => l.tax_credit !== undefined || l.vat_sum !== undefined);
  payload.different_vats = mixed ? 1 : 0;

  if (input.iban) {
    const iban = normalizeIban(input.iban);
    if (!isValidIban(iban)) errors.push(`iban ${input.iban} is not a valid IBAN`);
    payload.IBAN = iban;
  }
  if (input.note) payload.note = input.note;
  if (input.categories?.length) payload.tags = input.categories;

  if (input.protocol) {
    if (input.protocol.number) payload.protocol_number = padDocNumber(input.protocol.number);
    if (input.protocol.date) payload.protocol_date = isoToBg(input.protocol.date);
    payload.protocol_reason = input.protocol.reason;
  }

  if (input.lines.length === 0) errors.push('lines must contain at least one line');
  payload.items = input.lines.map((line) => {
    const item: Payload = {
      name: line.name,
      quantity: line.quantity,
      price: line.unit_price,
      unit_name: line.unit,
      purchase_account_code: line.expense_account,
      tracked: line.track_inventory ? 1 : 0,
    };
    if (line.description) item.description = line.description;
    if (line.sku) item.sku = line.sku;
    if (line.revenue_account !== undefined) item.sale_account_code = line.revenue_account;
    if (line.match_by_sku_only) item.search_only_by_sku = 1;
    if (mixed) {
      const credit = line.tax_credit ?? 'full';
      item.vat_type = TAX_CREDIT_TYPES[credit];
      item.vat_amount = credit === 'none' || credit === 'tro' ? 0 : (line.vat_sum ?? undefined);
    }
    return item;
  });

  const totals = computeTotals(
    input.lines.map((l) => ({ quantity: l.quantity, unit_price: l.unit_price, rate: input.vat_rate })),
    input.prices_include_vat,
    currency,
  );
  return { payload, errors, warnings, totals };
}

export const BILL_FIELD_MAP: Record<string, string> = {
  ...INVOICE_FIELD_MAP,
  identifier: 'supplier.eik',
  recipient_vat: 'supplier.vat_number',
  recipient_company_name: 'supplier.name',
  bulgarian_recipient: 'supplier.is_bulgarian',
  billed_at: 'tax_event_date',
  'items[].unit_name': 'lines[].unit',
  'items[].purchase_account_code': 'lines[].expense_account',
  'items[].sale_account_code': 'lines[].revenue_account',
  'items[].tracked': 'lines[].track_inventory',
  'items[].vat_type': 'lines[].tax_credit',
  'items[].vat_amount': 'lines[].vat_sum',
  'items[].search_only_by_sku': 'lines[].match_by_sku_only',
  protocol_number: 'protocol.number',
  protocol_date: 'protocol.date',
  protocol_reason: 'protocol.reason',
  callback_url: 'NULA_BILL_CALLBACK_URL (configuration)',
};
