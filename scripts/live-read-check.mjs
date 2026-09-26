/**
 * Live end-to-end check of every READ-ONLY tool through the MCP protocol against the real nula.bg API.
 *
 * Prints only structure: tool name, success, which fields came back and how many records.
 * Business data (names, amounts, IBANs) is never printed.
 *
 *   NULA_API_KEY=… node scripts/live-read-check.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadConfig, assertServable } = await import(`${root}/dist/config.js`);
const { createNulaServer } = await import(`${root}/dist/server.js`);
const { todaySofia, addDays } = await import(`${root}/dist/mappers/dates.js`);

const config = loadConfig();
assertServable(config);
if (!config.readOnly) {
  console.error('Refusing to run: NULA_READ_ONLY is false. This check must run in read-only mode.');
  process.exit(2);
}

const server = createNulaServer({ config, logger: { debug() {}, info() {}, warn() {}, error() {} } });
const client = new Client({ name: 'live-read-check', version: '1.0.0' }, { capabilities: {} });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

const { tools } = await client.listTools();
console.log(`tools offered: ${tools.length} (read-only mode)\n`);

const today = todaySofia();
const state = {};

async function call(name, args, extract) {
  const started = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args });
    const sc = res.structuredContent ?? {};
    const items = Array.isArray(sc.items) ? sc.items : undefined;
    const textLen = (res.content ?? []).filter((c) => c.type === 'text').reduce((n, c) => n + c.text.length, 0);
    const blocks = (res.content ?? []).map((c) => c.type).filter((t) => t !== 'text');
    if (res.isError) {
      const msg = (res.content ?? []).find((c) => c.type === 'text')?.text ?? '';
      console.log(`✗ ${name}  ERROR: ${msg.split('\n')[0].slice(0, 160)}`);
      return undefined;
    }
    const fields = items?.[0] ? Object.keys(items[0]) : Object.keys(sc);
    console.log(
      `✓ ${name}  ${Date.now() - started}ms  ${items ? `${items.length} record(s)` : 'object'}  ` +
        `text:${textLen}ch${blocks.length ? ` blocks:${blocks.join(',')}` : ''}\n    fields: ${fields.join(', ') || '(none)'}`,
    );
    if (extract) extract(sc, items);
    return sc;
  } catch (err) {
    console.log(`✗ ${name}  THREW: ${err.message}`);
    return undefined;
  }
}

// --- reads ------------------------------------------------------------------
await call('nula_list_bank_accounts', {}, (_sc, items) => {
  state.bankId = items?.[0]?.id;
});
await call('nula_list_bank_transactions', {
  bank_account_id: state.bankId,
  date_from: addDays(today, -60),
  date_to: today,
});
await call('nula_search_invoices', { date_from: addDays(today, -90), date_to: today }, (_sc, items) => {
  state.invoiceNumber = items?.[0]?.number;
  state.invoiceId = items?.[0]?.id;
  state.customerEik = items?.[0]?.customer?.eik;
});
await call('nula_search_invoices', { number: state.invoiceNumber, response_format: 'detailed' }, (_sc, items) => {
  state.hasLines = Array.isArray(items?.[0]?.lines);
  console.log(`    lines present: ${state.hasLines}`);
});
await call('nula_search_invoices', { date_from: addDays(today, -90), date_to: today, document_type: 'proforma' });
await call('nula_get_invoice_pdf', { invoice_id: state.invoiceId, number: state.invoiceNumber });
await call('nula_search_bills', { date_from: addDays(today, -90), date_to: today }, (_sc, items) => {
  state.billId = items?.[0]?.id;
});
await call('nula_search_bills', { bill_id: state.billId });
await call('nula_search_customers', { page: 1 }, (_sc, items) => {
  state.customerId = items?.[0]?.id;
  state.customerSearch = items?.[0]?.eik;
});
await call('nula_search_customers', { customer_id: state.customerId });
await call('nula_search_customers', { search: state.customerSearch });
await call('nula_lookup_company', { eik: state.customerEik ?? state.customerSearch });
await call('nula_search_items', { page: 1 }, (_sc, items) => {
  state.sku = items?.[0]?.sku;
});
await call('nula_search_items', { sku: state.sku });
await call('nula_list_item_categories', {});
await call('nula_receivables_report', { as_of: today, date_from: addDays(today, -180) });
await call('nula_period_summary', { month: today.slice(0, 7) });
await call('nula_match_bank_transactions', {
  bank_account_id: state.bankId,
  date_from: addDays(today, -30),
  date_to: today,
});

// --- resources and prompts --------------------------------------------------
const res = await client.listResources();
console.log(`\nresources: ${res.resources.map((r) => r.uri).join(', ')}`);
const ref = await client.readResource({ uri: 'nula://reference/zero-vat-reasons' });
console.log(`reference resource: ${ref.contents[0].text.length} chars`);
const prompts = await client.listPrompts();
console.log(`prompts: ${prompts.prompts.map((p) => p.name).join(', ')}`);

await client.close();
await server.close();
