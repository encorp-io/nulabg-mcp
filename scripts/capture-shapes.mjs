/**
 * Phase 0 discovery: calls every READ-ONLY nula.bg endpoint with a real API key and reports the
 * SHAPE of each response — field names, types and which normalizer fields resolved.
 *
 * Privacy: values are never printed. Full raw responses are written to test/fixtures/live/ only with
 * --save (that folder is git-ignored), so you can inspect them locally.
 *
 * Nothing is created, changed, sent or deleted.
 *
 *   NULA_API_KEY=… node scripts/capture-shapes.mjs [--save]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const save = process.argv.includes('--save');
const outDir = path.join(root, 'test', 'fixtures', 'live');

const { loadConfig } = await import(path.join(root, 'dist', 'config.js'));
const { NulaClient } = await import(path.join(root, 'dist', 'nula', 'client.js'));
const N = await import(path.join(root, 'dist', 'nula', 'normalize.js'));
const { todaySofia, addDays, toDateRange } = await import(path.join(root, 'dist', 'mappers', 'dates.js'));

const config = loadConfig();
if (!config.defaultProfile) {
  console.error('Set NULA_API_KEY first (nothing will be written to nula.bg).');
  process.exit(2);
}
const client = new NulaClient({
  apiKey: config.profiles[config.defaultProfile],
  baseUrl: config.baseUrl,
  timeoutMs: config.timeoutMs,
});

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v);

/** Field names and types, one level deep. Values are never included. */
function shape(value, depth = 0) {
  if (Array.isArray(value))
    return value.length ? { _array: value.length, _item: shape(value[0], depth + 1) } : { _array: 0 };
  if (!value || typeof value !== 'object') return typeOf(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      depth < 2 && v && typeof v === 'object'
        ? shape(v, depth + 1)
        : typeof v === 'string' && v.length > 60
          ? `string(${v.length})`
          : typeOf(v);
  }
  return out;
}

const resolved = (obj) => Object.keys(obj ?? {}).filter((k) => k !== 'raw');

const results = [];
async function probe(name, run, normalize) {
  const started = Date.now();
  try {
    const body = await run();
    const entry = { name, ok: true, ms: Date.now() - started, shape: shape(body) };
    if (normalize) {
      const { items } = N.extractList(body);
      entry.records = items.length;
      if (items[0]) {
        entry.item_keys = Object.keys(items[0]);
        entry.normalized_fields = resolved(normalize(items[0]));
      }
    }
    results.push(entry);
    if (save && body !== undefined) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, `${name.replace(/[^a-z0-9]+/gi, '-')}.json`), JSON.stringify(body, null, 2));
    }
    return body;
  } catch (err) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      status: err.status,
      kind: err.kind,
      message: err.message,
    });
    return undefined;
  }
}

const today = todaySofia();
const yearAgo = addDays(today, -365);
const range = toDateRange(yearAgo, today);
const first = (body, normalize) => {
  const { items } = N.extractList(body ?? {});
  return items[0] ? { raw: items[0], norm: normalize ? normalize(items[0]) : undefined } : undefined;
};

// --- core -------------------------------------------------------------------
const banks = await probe(
  'getBanks',
  () => client.get('/api/v1/getBanks', { query: { allBanks: 0 } }),
  N.normalizeBankAccount,
);
await probe('getNextInvoiceNumber-invoice', () => client.get('/api/v1/getNextInvoiceNumber', { query: { type: 1 } }));
await probe('getNextInvoiceNumber-proforma', () => client.get('/api/v1/getNextInvoiceNumber', { query: { type: 0 } }));

// --- invoices / bills -------------------------------------------------------
const invoices = await probe(
  'getInvoices',
  () => client.get('/api/v1/getInvoices', { query: { daterange: range, page: 1 } }),
  N.normalizeInvoice,
);
const inv = first(invoices, N.normalizeInvoice);
if (inv?.norm?.number) {
  await probe(
    'getInvoicesByNumber',
    () => client.get('/api/v1/getInvoicesByNumber', { query: { number: inv.norm.number } }),
    N.normalizeInvoice,
  );
}
const bills = await probe(
  'bills',
  () => client.get('/api/v1/bills', { query: { daterange: range, page: 1 } }),
  N.normalizeBill,
);
const bill = first(bills, N.normalizeBill);
if (bill?.norm?.id) await probe('ocr-bill-by-id', () => client.get(`/api/v1/ocr/bill/${bill.norm.id}`));

// --- customers / company lookup --------------------------------------------
const customers = await probe(
  'customers',
  () => client.get('/api/v1/customers', { query: { page: 1 } }),
  N.normalizeCustomer,
);
const cust = first(customers, N.normalizeCustomer);
if (cust?.norm?.id) await probe('customer-by-id', () => client.get(`/api/v1/customers/${cust.norm.id}`));
if (cust?.norm?.eik) {
  await probe('getCompanyDetails', () =>
    client.get('/api/v1/getCompanyDetails', { query: { bulgarian_recipient: 1, identifier: cust.norm.eik } }),
  );
}

// --- inventory --------------------------------------------------------------
const products = await probe('open-cart-products', () =>
  client.get('/api/v1/open-cart/products', { query: { per_page: 5, page: 1 } }),
);
await probe('open-cart-categories', () => client.get('/api/v1/open-cart/categories', { query: { per_page: 5 } }));
const sku = (() => {
  const data = N.unwrap(products ?? {});
  const list = Array.isArray(data?.products) ? data.products : N.extractList(products ?? {}).items;
  return list?.[0]?.sku;
})();
if (sku) {
  await probe('open-cart-product-by-sku', () => client.get(`/api/v1/open-cart/products/${encodeURIComponent(sku)}`));
  await probe('getItemDetails', () => client.get('/api/v1/getItemDetails', { query: { sku } }));
}

// --- banking ----------------------------------------------------------------
const bankId = first(banks, N.normalizeBankAccount)?.norm?.id;
if (bankId) {
  await probe(
    'getTransactions',
    () =>
      client.get(`/api/v1/transactions/${bankId}/getTransactions`, {
        query: { from: addDays(today, -60), to: today, page: 1 },
      }),
    N.normalizeTransaction,
  );
}

// --- native: OCR, НАП, НОИ --------------------------------------------------
await probe('native-ocr-quota', () => client.get('/api/native/v1/ocr/quota'));
const uploads = await probe('native-ocr-uploads', () => client.get('/api/native/v1/ocr/uploads'));
const upload = first(uploads);
const uploadType = upload?.raw && (upload.raw.type ?? upload.raw.document_type);
const uploadId = upload?.raw?.id;
if (uploadId && uploadType) {
  await probe('native-ocr-upload-by-id', () =>
    client.get(`/api/native/v1/ocr/uploads/${String(uploadType).includes('invoice') ? 'invoice' : 'bill'}/${uploadId}`),
  );
}
await probe('native-nra-declarations', () =>
  client.get('/api/native/v1/nra/declarations', { timeoutMs: config.timeoutMs * 2 }),
);
await probe('native-noi-documents', () => client.get('/api/native/v1/noi/documents'));

// --- report -----------------------------------------------------------------
const ok = results.filter((r) => r.ok).length;
console.log(`\n=== nula.bg shape report: ${ok}/${results.length} endpoints answered (${config.baseUrl}) ===\n`);
console.log(JSON.stringify(results, null, 2));
if (save) console.log(`\nRaw responses saved to ${path.relative(root, outDir)}/ (git-ignored).`);
