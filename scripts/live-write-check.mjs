/**
 * ONE-OFF live write test, run only with the account owner's explicit approval.
 *
 * Issues a small test invoice, edits it, e-mails it to the address given on the command line and deletes it
 * again, driving the real MCP tools against the real nula.bg API. Every step is printed and verified.
 *
 *   NULA_API_KEY=… NULA_READ_ONLY=false node scripts/live-write-check.mjs --yes --email you@example.com
 *
 * Automated tests never use this script: they run against a fake nula.bg API (see test/).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadConfig, assertServable } = await import(`${root}/dist/config.js`);
const { createNulaServer } = await import(`${root}/dist/server.js`);
const { todaySofia, addDays } = await import(`${root}/dist/mappers/dates.js`);

const argv = process.argv.slice(2);
const email = argv[argv.indexOf('--email') + 1];
const CUSTOMER = { name: 'Криптоапс ЕООД', eik: '204918876', vat_number: 'BG204918876' };

if (!argv.includes('--yes') || !email?.includes('@')) {
  console.error('Refusing to run without --yes and --email <address>.');
  process.exit(2);
}

const config = loadConfig();
assertServable(config);
if (config.readOnly) {
  console.error('NULA_READ_ONLY must be false for this test.');
  process.exit(2);
}

const server = createNulaServer({ config, logger: { debug() {}, info() {}, warn() {}, error() {} } });
const client = new Client({ name: 'live-write-check', version: '1.0.0' }, { capabilities: {} });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  console.log(`\n── ${name} ${res.isError ? '✗ ERROR' : '✓'}\n${text.split('\n').slice(0, 4).join('\n')}`);
  if (res.isError) throw new Error(`${name} failed`);
  return res.structuredContent ?? {};
};

const today = todaySofia();
const invoice = {
  customer: CUSTOMER,
  document_type: 'invoice',
  issue_date: today,
  tax_event_date: today,
  due_date: addDays(today, 15),
  currency: 'EUR',
  prices_include_vat: false,
  vat_rate: 20,
  payment_method: 'bank_transfer',
  categories: ['test'],
  note: 'ТЕСТОВА ФАКТУРА за проверка на MCP интеграцията. Ще бъде изтрита веднага след теста.',
  lines: [
    {
      name: 'Тестова услуга (MCP интеграция)',
      description: 'Тестов ред, издаден автоматично при проверка на интеграцията',
      quantity: 1,
      unit_price: 10,
      kind: 'service',
    },
  ],
};

// 1. Who is the customer?
const lookup = await call('nula_lookup_company', { eik: CUSTOMER.eik });
console.log(`   registry name: ${lookup.name ?? '(not found)'} | VAT: ${lookup.vat_number ?? '—'}`);

// 2. Preview (writes nothing).
const preview = await call('nula_create_invoice', { ...invoice, preview_only: true });
console.log(`   next number: ${preview.number} | totals: ${JSON.stringify(preview.totals)}`);

// 3. Create.
const created = await call('nula_create_invoice', invoice);
const number = created.number ?? preview.number;
console.log(`   created id=${created.id} number=${number}`);

// 4. Read it back.
const found = await call('nula_search_invoices', { number, response_format: 'detailed' });
console.log(
  `   read back: ${JSON.stringify(found.items?.[0]?.total)} ${found.items?.[0]?.currency} | lines: ${found.items?.[0]?.lines?.length}`,
);

// 5. Edit it: two units instead of one.
await call('nula_update_invoice', {
  invoice_id: created.id,
  ...invoice,
  lines: [{ ...invoice.lines[0], quantity: 2 }],
  note: 'ТЕСТОВА ФАКТУРА (редактирана при теста). Ще бъде изтрита.',
});
const edited = await call('nula_search_invoices', { number, response_format: 'detailed' });
console.log(`   after edit: total ${edited.items?.[0]?.total} | qty ${edited.items?.[0]?.lines?.[0]?.quantity}`);

// 6. Mark it paid, then read the status back.
await call('nula_update_invoice_metadata', { invoice_id: created.id, number, is_paid: true, is_sent: false });
const afterStatus = await call('nula_search_invoices', { number });
console.log(`   payment status: ${afterStatus.items?.[0]?.payment_status}`);

// 7. PDF.
const pdf = await call('nula_get_invoice_pdf', { invoice_id: created.id, number });
console.log(`   pdf: ${pdf.path} (${pdf.size_bytes} bytes)`);

// 8. E-mail it.
await call('nula_email_invoice', { invoice_id: created.id, to: email, language: 'bg', attach_as: 'file' });

// 9. Delete it and confirm it is gone.
await call('nula_delete_last_invoice', { expected_number: number, reason: 'MCP integration test' });
const after = await call('nula_search_invoices', { number });
console.log(`   records with number ${number} after delete: ${after.items?.length ?? 0}`);
const next = await call('nula_get_invoice_pdf', { invoice_id: created.id, number }).catch(() => undefined);
console.log(`   PDF after delete: ${next ? 'still downloadable (nula.bg keeps the file)' : 'gone'}`);

await client.close();
await server.close();
console.log('\nDone.');
