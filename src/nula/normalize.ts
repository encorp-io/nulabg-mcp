/**
 * Normalisation of nula.bg responses.
 *
 * The field names below were verified against the live API on 2026-09-26 (see
 * docs/research/nula-api-analysis.md §7). Alternative names are kept as fallbacks where the
 * OpenAPI spec or other endpoints suggest them. Fields the API does not return are omitted, never invented.
 */
import { normalizeDate } from '../mappers/dates.ts';
import { INVOICE_DOCUMENT_TYPE_BY_CODE, INVOICE_PAYMENT_METHODS } from '../mappers/enums.ts';
import { round2, toNumber } from '../mappers/money.ts';

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns the `data` of a `{statusCode, message, data}` envelope, or the body itself. */
export function unwrap(body: unknown): unknown {
  if (isObj(body) && 'data' in body && ('statusCode' in body || 'message' in body)) return body.data;
  return body;
}

export interface Page {
  page?: number;
  per_page?: number;
  total?: number;
  last_page?: number;
  next_page?: number;
  has_more?: boolean;
}

const LIST_KEYS = [
  'data',
  'items',
  'results',
  'invoices',
  'bills',
  'customers',
  'products',
  'categories',
  'banks',
  'transactions',
  'uploads',
  'declarations',
  'documents',
  'submissions',
];

const isNumericKey = (k: string) => /^\d+$/.test(k);

function nonNumeric(obj: Obj): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !isNumericKey(k)));
}

/**
 * Extracts the records and pagination from a list payload. nula.bg mostly returns
 * `data` as an object keyed `"0".."99"` plus `current_page` / `next_page` / `last_page`
 * (not a Laravel paginator), and `getBanks` nests its accounts one array deep.
 */
export function extractList(payload: unknown, requestedPage?: number): { items: Obj[]; page: Page } {
  let node: unknown = unwrap(payload);
  let meta: Obj = {};

  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((n) => Array.isArray(n))) {
        node = node.flat();
        continue;
      }
      break;
    }
    if (!isObj(node)) break;

    const numericKeys = Object.keys(node).filter(isNumericKey);
    if (numericKeys.length > 0) {
      meta = { ...meta, ...nonNumeric(node) };
      const keyed = node;
      node = numericKeys.sort((a, b) => Number(a) - Number(b)).map((k) => keyed[k]);
      continue;
    }
    // A single record (e.g. an invoice whose `items` are its lines) is not a list wrapper.
    if ('id' in node && !('current_page' in node) && !('last_page' in node)) break;

    meta = {
      ...meta,
      ...node,
      ...(isObj(node.meta) ? node.meta : {}),
      ...(isObj(node.pagination) ? node.pagination : {}),
    };
    const key = LIST_KEYS.find((k) => Array.isArray(node && (node as Obj)[k]) || isObj((node as Obj)[k]));
    if (!key) break;
    node = (node as Obj)[key];
  }

  // An empty page is `{current_page, next_page, last_page}` with no numeric keys: that is zero records,
  // not one record made of the pagination fields.
  const PAGINATION_ONLY = ['current_page', 'next_page', 'last_page', 'per_page', 'total'];
  const isPaginationWrapper = isObj(node) && Object.keys(node).every((k) => PAGINATION_ONLY.includes(k));
  const items = Array.isArray(node) ? node.filter(isObj) : isObj(node) && !isPaginationWrapper ? [node] : [];
  const page: Page = {
    page: toNumber(meta.current_page) ?? requestedPage,
    per_page: toNumber(meta.per_page),
    total: toNumber(meta.total),
    last_page: toNumber(meta.last_page),
    next_page: toNumber(meta.next_page),
  };
  if (page.next_page !== undefined) page.has_more = page.page === undefined || page.next_page > page.page;
  else if (meta.next_page === null || meta.next_page_url === null) page.has_more = false;
  else if (page.page !== undefined && page.last_page !== undefined) page.has_more = page.page < page.last_page;
  else if (typeof meta.next_page_url === 'string') page.has_more = true;
  return { items, page: stripUndefined(page) };
}

export function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** First non-empty value among candidate keys (supports dotted paths). */
export function pick(obj: Obj, ...keys: string[]): unknown {
  for (const key of keys) {
    let cur: unknown = obj;
    for (const part of key.split('.')) cur = isObj(cur) ? cur[part] : undefined;
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

export const pickStr = (obj: Obj, ...keys: string[]): string | undefined => {
  const v = pick(obj, ...keys);
  return typeof v === 'string' ? v.trim() || undefined : typeof v === 'number' ? String(v) : undefined;
};
export const pickNum = (obj: Obj, ...keys: string[]): number | undefined => toNumber(pick(obj, ...keys));
export const pickBool = (obj: Obj, ...keys: string[]): boolean | undefined => {
  const v = pick(obj, ...keys);
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return undefined;
};

const HEAVY_KEYS = /^(file|files_content|content|base64|media|pdf|xml|blob|data_uri|signature|certificate)$/i;

/** Removes base64 blobs and very long strings so responses stay small. */
export function stripHeavy(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (typeof value === 'string') {
    if (value.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 200))) {
      return `[binary omitted: ${value.length} chars]`;
    }
    if (value.startsWith('data:') && value.length > 200) return `[data URI omitted: ${value.length} chars]`;
    return value.length > 4000 ? `${value.slice(0, 4000)}… [truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => stripHeavy(v, depth + 1));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (HEAVY_KEYS.test(k) && typeof v === 'string' && v.length > 500) out[k] = `[omitted: ${v.length} chars]`;
      else out[k] = stripHeavy(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function htmlToText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function categories(obj: Obj): string[] | undefined {
  const raw = pick(obj, 'tags', 'categories', 'category');
  if (Array.isArray(raw)) {
    const names = raw
      .map((t) => (typeof t === 'string' ? t : isObj(t) ? pickStr(t, 'name', 'title', 'bg.name') : undefined))
      .filter((t): t is string => Boolean(t));
    return names.length ? names : undefined;
  }
  return typeof raw === 'string' && raw ? [raw] : undefined;
}

/** `customer` on invoices, `vendor` on bills; both carry id/name/identifier/vat_number/city/country/address. */
function counterparty(obj: Obj, kind: 'customer' | 'supplier'): Obj {
  const nested = pick(
    obj,
    kind === 'customer' ? 'customer' : 'vendor',
    'client',
    'recipient',
    'supplier',
    'contragent',
  );
  const src = isObj(nested) ? nested : {};
  const fallbackName =
    typeof nested === 'string' ? nested : pickStr(obj, 'recipient', 'recipient_company_name', 'vendor_name');
  return stripUndefined({
    id: pickNum(src, 'id'),
    name: pickStr(src, 'name', 'company_name') ?? fallbackName,
    eik: pickStr(src, 'identifier', 'eik', 'bulstat') ?? pickStr(obj, 'vendor_identifier', 'identifier'),
    vat_number: pickStr(src, 'vat_number', 'vat_id', 'vat') ?? pickStr(obj, 'vendor_vat_id', 'recipient_vat'),
    city: pickStr(src, 'city'),
    country: pickStr(src, 'country'),
  });
}

function documentType(obj: Obj): string | undefined {
  const code = pickNum(obj, 'type', 'invoice_type', 'document_type_id');
  if (code !== undefined && INVOICE_DOCUMENT_TYPE_BY_CODE[code]) return INVOICE_DOCUMENT_TYPE_BY_CODE[code];
  return pickStr(obj, 'document_type', 'type_name');
}

/** nula.bg returns English labels: Paid / Unpaid / Partially paid / Invalid. */
const PAYMENT_STATUS: Record<string, 'paid' | 'unpaid' | 'partially_paid' | 'invalid'> = {
  paid: 'paid',
  платена: 'paid',
  unpaid: 'unpaid',
  неплатена: 'unpaid',
  'partially paid': 'partially_paid',
  'частично платена': 'partially_paid',
  invalid: 'invalid',
  анулирана: 'invalid',
};

function paymentStatus(obj: Obj) {
  const raw = pickStr(obj, 'status', 'payment_status');
  const status = raw ? PAYMENT_STATUS[raw.toLowerCase()] : undefined;
  const isPaid = status === 'paid' ? true : status === 'unpaid' || status === 'partially_paid' ? false : undefined;
  return { status, isPaid, raw };
}

const PAYMENT_METHOD_BY_CODE = Object.fromEntries(
  Object.entries(INVOICE_PAYMENT_METHODS).map(([name, code]) => [code, name]),
) as Record<number, string>;

function paymentMethod(obj: Obj): string | undefined {
  const code = pickNum(obj, 'payment_method_id');
  if (code !== undefined && PAYMENT_METHOD_BY_CODE[code]) return PAYMENT_METHOD_BY_CODE[code];
  return pickStr(obj, 'payment_method');
}

/** `amount` is net and `vat_value` the VAT sum, both in the document's own currency. */
function amounts(obj: Obj) {
  const net = pickNum(obj, 'amount', 'amount_without_vat', 'subtotal', 'net', 'tax_base');
  const vat = pickNum(obj, 'vat_value', 'vat_sum', 'total_vat');
  const total =
    pickNum(obj, 'total', 'total_amount', 'total_with_vat') ??
    (net !== undefined ? round2(net + (vat ?? 0)) : undefined);
  const currency = pickStr(obj, 'currency_code', 'currency');
  const defaultCurrency = pickStr(obj, 'default_currency_code');
  const totalInDefault = pickNum(obj, 'total_amount_in_default_currency');
  return stripUndefined({
    currency,
    net,
    vat,
    total,
    // Only meaningful for foreign-currency documents: nula.bg converts these to the company currency.
    total_in_default_currency: defaultCurrency && currency !== defaultCurrency ? totalInDefault : undefined,
    default_currency: defaultCurrency && currency !== defaultCurrency ? defaultCurrency : undefined,
    exchange_rate: pickNum(obj, 'exchange_rate'),
  });
}

export function normalizeLines(obj: Obj): Obj[] | undefined {
  const raw = pick(obj, 'items', 'invoice_items', 'bill_items', 'products', 'lines', 'rows');
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(isObj).map((l) =>
    stripUndefined({
      name: pickStr(l, 'name', 'title'),
      description: pickStr(l, 'description', 'note'),
      sku: pickStr(l, 'sku', 'code'),
      quantity: pickNum(l, 'quantity', 'qty'),
      unit: pickStr(l, 'unit', 'unit_name', 'measure'),
      unit_price: pickNum(l, 'price', 'unit_price', 'single_price'),
      vat_rate: pickNum(l, 'vat_amount', 'vat_rate', 'vat_percent'),
      vat_type: pickNum(l, 'vat_type'),
      discount_amount: pickNum(l, 'discount_amount'),
      amount: pickNum(l, 'amount', 'total', 'sum', 'total_price'),
    }),
  );
}

export function normalizeInvoice(obj: Obj, detailed = false): Obj {
  const status = paymentStatus(obj);
  const priceType = pickStr(obj, 'price_type');
  const out: Obj = stripUndefined({
    id: pickNum(obj, 'id', 'invoice_id'),
    number: pickStr(obj, 'number', 'invoice_number', 'document_number'),
    document_type: documentType(obj),
    issue_date: normalizeDate(pick(obj, 'created_at', 'issued_at', 'issue_date', 'date')),
    tax_event_date: normalizeDate(pick(obj, 'invoiced_at', 'tax_event_date', 'tax_date')),
    due_date: normalizeDate(pick(obj, 'due_at', 'due_date', 'payment_due')),
    customer: counterparty(obj, 'customer'),
    ...amounts(obj),
    vat_rate: pickNum(obj, 'vat_amount', 'vat_rate'),
    has_different_vats: pickBool(obj, 'has_different_vats'),
    zero_vat_reason: pickNum(obj, 'no_vat_reason'),
    zero_vat_reason_text: pickStr(obj, 'no_vat_reason_text'),
    prices_include_vat: priceType ? priceType === 'with_vat' : undefined,
    payment_status: status.status,
    is_paid: status.isPaid,
    payment_method: paymentMethod(obj),
    vat_period: pickStr(obj, 'vat_period'),
    iban: pickStr(obj, 'IBAN', 'iban'),
    categories: categories(obj),
    note: detailed ? pickStr(obj, 'note', 'notes') : undefined,
    lines: detailed ? normalizeLines(obj) : undefined,
  });
  if (detailed) out.raw = stripHeavy(obj);
  return out;
}

export function normalizeBill(obj: Obj, detailed = false): Obj {
  const status = paymentStatus(obj);
  const priceType = pickStr(obj, 'price_type');
  const out: Obj = stripUndefined({
    id: pickNum(obj, 'id', 'bill_id'),
    number: pickStr(obj, 'number', 'invoice_number', 'document_number'),
    document_type: documentType(obj),
    issue_date: normalizeDate(pick(obj, 'created_at', 'issue_date', 'date')),
    tax_event_date: normalizeDate(pick(obj, 'billed_at', 'invoiced_at', 'tax_event_date')),
    due_date: normalizeDate(pick(obj, 'due_at', 'due_date')),
    vat_period: pickStr(obj, 'vat_period'),
    supplier: counterparty(obj, 'supplier'),
    ...amounts(obj),
    vat_rate: pickNum(obj, 'vat_amount', 'vat_rate'),
    has_different_vats: pickBool(obj, 'has_different_vats'),
    prices_include_vat: priceType ? priceType === 'with_vat' : undefined,
    payment_status: status.status,
    is_paid: status.isPaid,
    payment_method: paymentMethod(obj),
    has_eu_vat: pickBool(obj, 'has_eu_vat'),
    requires_additional_doc: pickBool(obj, 'requires_additional_doc'),
    iban: pickStr(obj, 'IBAN', 'iban'),
    categories: categories(obj),
    lines: detailed ? normalizeLines(obj) : undefined,
  });
  if (detailed) out.raw = stripHeavy(obj);
  return out;
}

export function normalizeCustomer(obj: Obj, detailed = false): Obj {
  const contacts = pick(obj, 'contacts');
  const out: Obj = stripUndefined({
    id: pickNum(obj, 'id'),
    name: pickStr(obj, 'name', 'company_name'),
    eik: pickStr(obj, 'identifier', 'eik', 'bulstat'),
    vat_number: pickStr(obj, 'vat_number', 'vat', 'recipient_vat'),
    city: pickStr(obj, 'city', 'address.city'),
    post_code: pickStr(obj, 'post_code'),
    country: pickStr(obj, 'country', 'address.country'),
    address: pickStr(obj, 'address', 'аddress'), // nula.bg also spells it with a Cyrillic "а"
    contacts_count: Array.isArray(contacts) ? contacts.length : undefined,
    contacts: detailed && Array.isArray(contacts) ? contacts : undefined,
  });
  if (detailed) out.raw = stripHeavy(obj);
  return out;
}

export function normalizeBankAccount(obj: Obj): Obj {
  return stripUndefined({
    id: pickNum(obj, 'id', 'bank_id', 'account_id'),
    name: pickStr(obj, 'name', 'bank_name', 'bank', 'title'),
    iban: pickStr(obj, 'IBAN', 'iban', 'account_number'),
    bic: pickStr(obj, 'BIC', 'bic'),
    currency: pickStr(obj, 'currency_code', 'currency'),
    balance: pickNum(obj, 'balance', 'current_balance', 'available_balance'),
    enabled: pickBool(obj, 'enabled'),
    is_default: pickBool(obj, 'is_default', 'default'),
    consent_status: pickStr(obj, 'consent_status'),
    consent_valid_until: normalizeDate(pick(obj, 'consent_valid_until')),
  });
}

export function normalizeTransaction(obj: Obj): Obj {
  const amount = pickNum(obj, 'amount', 'sum', 'value');
  // nula.bg reports the direction in Bulgarian and keeps amounts positive.
  const operation = pickStr(obj, 'operation', 'direction', 'type', 'credit_debit', 'transaction_type')?.toLowerCase();
  let direction: 'in' | 'out' | undefined;
  if (operation && /(кредит|credit|in|incoming|приход)/.test(operation)) direction = 'in';
  else if (operation && /(дебит|debit|out|outgoing|разход)/.test(operation)) direction = 'out';
  else if (amount !== undefined && amount < 0) direction = 'out';
  return stripUndefined({
    id: pickNum(obj, 'id', 'transaction_id'),
    date: normalizeDate(pick(obj, 'value_date', 'date', 'booking_date', 'transaction_date', 'created_at')),
    amount: amount === undefined ? undefined : Math.abs(amount),
    direction,
    currency: pickStr(obj, 'currency_code', 'currency'),
    counterparty: pickStr(obj, 'counterparty_name', 'counterparty', 'partner_name', 'creditor_name', 'debtor_name'),
    counterparty_iban: pickStr(obj, 'counterparty_bank_account', 'counterparty_iban', 'partner_iban'),
    counterparty_bank: pickStr(obj, 'counterparty_bank_name'),
    description: pickStr(obj, 'description', 'reason', 'remittance_information', 'details', 'narrative', 'note'),
    reference: pickStr(obj, 'reference', 'end_to_end_id', 'ref'),
  });
}

/** `getCompanyDetails`: registry lookup with its own field names. */
export function normalizeCompanyLookup(obj: Obj): Obj {
  const vat = pickStr(obj, 'vat_id', 'vat_number');
  return stripUndefined({
    name: pickStr(obj, 'name', 'company_name'),
    eik: pickStr(obj, 'identifier', 'eik', 'uic', 'bulstat'),
    legal_form: pickStr(obj, 'legal_form_short', 'legal_form'),
    vat_number: vat,
    is_vat_registered: pickBool(obj, 'vat', 'is_vat_registered', 'vat_registered') ?? (vat ? true : undefined),
    address: pickStr(obj, 'аddress', 'address', 'street'), // Cyrillic "а" as returned by nula.bg
    city: pickStr(obj, 'city', 'settlement'),
    post_code: pickStr(obj, 'post_code', 'postcode', 'zip'),
    country: pickStr(obj, 'country', 'country_code'),
    managers: pick(obj, 'managers'),
    last_update: normalizeDate(pick(obj, 'last_update')),
  });
}
