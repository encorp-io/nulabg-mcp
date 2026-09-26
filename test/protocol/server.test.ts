import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  connect,
  envelope,
  invoiceRecord,
  keyedEnvelope,
  type RecordedRequest,
  testConfig,
  textOf,
} from '../helpers.ts';

const invoiceArgs = {
  customer: { name: 'Пример ООД', eik: '204733952' },
  prices_include_vat: false,
  payment_method: 'bank_transfer',
  categories: ['consulting'],
  lines: [{ name: 'Консултации', quantity: 10, unit_price: 60, kind: 'service' }],
};

const createRoutes = {
  'POST /api/v1/createInvoice': () => envelope({ id: 5512, number: '0000000124' }),
  'GET /api/v1/getNextInvoiceNumber': () => envelope({ number: '0000000124' }),
  'GET /api/v1/customers': () => envelope({ current_page: 1, last_page: 1, data: [] }),
  'GET /api/v1/getInvoices': () => keyedEnvelope([]),
  'GET /api/v1/getInvoicesByNumber': () => envelope([]),
};

describe('tool registration', () => {
  it('registers the default toolsets with annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(21);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.nula_search_invoices?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.nula_email_invoice?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName.nula_create_invoice?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.nula_nra_declarations).toBeUndefined();
  });

  it('is read-only by default: no write tools, and the model is told how to enable them', async () => {
    const { client } = await connect({ config: testConfig() });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect(tools.some((t) => t.name === 'nula_create_invoice')).toBe(false);
    expect(client.getInstructions()).toMatch(/READ-ONLY.*NULA_READ_ONLY=false/s);
  });

  it('hides every write tool in read-only mode', async () => {
    const { client } = await connect({ config: testConfig({ NULA_READ_ONLY: 'true', NULA_TOOLSETS: 'all' }) });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('adds a company parameter when several profiles are configured', async () => {
    const config = testConfig({
      NULA_PROFILES: '{"alpha":"k1","beta":"k2"}',
      NULA_API_KEY: '',
      NULA_READ_ONLY: 'false',
    });
    const { client, api } = await connect({
      config,
      routes: { 'GET /api/v1/getBanks': () => envelope([{ id: 1, name: 'ДСК', iban: 'BG80BNBG96611020345678' }]) },
    });
    const { tools } = await client.listTools();
    const banks = tools.find((t) => t.name === 'nula_list_bank_accounts');
    expect(Object.keys(banks?.inputSchema.properties ?? {})).toContain('company');
    expect(tools.some((t) => t.name === 'nula_list_companies')).toBe(true);
    await client.callTool({ name: 'nula_list_bank_accounts', arguments: { company: 'beta' } });
    expect(api.calls[0]?.headers.get('authorization')).toBe('Bearer k2');
  });
});

describe('nula_create_invoice', () => {
  it('previews without writing anything', async () => {
    const { client, api } = await connect({ routes: createRoutes });
    const result = await client.callTool({
      name: 'nula_create_invoice',
      arguments: { ...invoiceArgs, preview_only: true },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/PREVIEW.*№0000000124.*720,00 €/s);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates after the user confirms via elicitation', async () => {
    const { client, api, elicitations } = await connect({
      routes: createRoutes,
      elicit: () => ({ action: 'accept', content: { confirm: true } }),
    });
    const result = await client.callTool({ name: 'nula_create_invoice', arguments: invoiceArgs });
    expect(result.isError).toBeFalsy();
    expect(elicitations).toHaveLength(1);
    expect(textOf(result)).toMatch(/Created фактура №0000000124 \(id 5512\)/);
    const post = api.calls.filter((c) => c.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]?.body).toMatchObject({ identifier: '204733952', items: [{ item_type: 3, price: 60 }] });
  });

  it('does nothing when the user declines', async () => {
    const { client, api } = await connect({
      routes: createRoutes,
      elicit: () => ({ action: 'accept', content: { confirm: false } }),
    });
    const result = await client.callTool({ name: 'nula_create_invoice', arguments: invoiceArgs });
    expect(textOf(result)).toMatch(/Cancelled/);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses a number that already exists', async () => {
    const { client, api } = await connect({
      routes: { ...createRoutes, 'GET /api/v1/getInvoices': () => keyedEnvelope([invoiceRecord()]) },
    });
    const result = await client.callTool({ name: 'nula_create_invoice', arguments: { ...invoiceArgs, number: '124' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/already exists/);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('reports nula.bg validation errors with MCP field names', async () => {
    const { client } = await connect({
      routes: {
        ...createRoutes,
        'POST /api/v1/createInvoice': () => ({
          status: 422,
          json: {
            message: 'The given data was invalid.',
            statusCode: 422,
            errors: { 'items.0.price': ['must be positive'] },
          },
        }),
      },
    });
    const result = await client.callTool({ name: 'nula_create_invoice', arguments: invoiceArgs });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('lines[0].unit_price: must be positive');
  });
});

describe('guarded tools', () => {
  it('refuses to delete an invoice that is not the last one', async () => {
    const { client, api } = await connect({
      routes: { 'GET /api/v1/getNextInvoiceNumber': () => envelope({ number: '0000000125' }) },
    });
    const result = await client.callTool({ name: 'nula_delete_last_invoice', arguments: { expected_number: '120' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/last invoice is №0000000124/);
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('deletes the last invoice after confirmation', async () => {
    const { client, api } = await connect({
      elicit: () => ({ action: 'accept', content: { confirm: true } }),
      routes: {
        'GET /api/v1/getNextInvoiceNumber': () => envelope({ number: '0000000125' }),
        'GET /api/v1/getInvoices': () => keyedEnvelope([invoiceRecord()]),
        'DELETE /api/v1/deleteInvoice': () => envelope('[Success]'),
      },
    });
    const result = await client.callTool({ name: 'nula_delete_last_invoice', arguments: { expected_number: '124' } });
    expect(result.isError).toBeFalsy();
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('never retries sending an e-mail', async () => {
    let sends = 0;
    const { client } = await connect({
      routes: {
        'GET /api/v1/invoice/7/email': () => {
          sends++;
          return { status: 503, json: { message: 'down', statusCode: 503 } };
        },
      },
    });
    const result = await client.callTool({ name: 'nula_email_invoice', arguments: { invoice_id: 7, to: 'a@b.bg' } });
    expect(result.isError).toBe(true);
    expect(sends).toBe(1);
  });
});

describe('invoice lifecycle (mocked nula.bg)', () => {
  /** Mirrors the live write test: create → read back → edit → mark paid → PDF → e-mail → delete. */
  function lifecycleRoutes() {
    const state = {
      created: undefined as Record<string, unknown> | undefined,
      deleted: false,
      emails: [] as string[],
      paid: false,
    };
    const routes = {
      'GET /api/v1/getCompanyDetails': () =>
        envelope({
          identifier: '204918876',
          name: 'Криптоапс',
          legal_form_short: 'ЕООД',
          vat: 1,
          vat_id: 'BG204918876',
        }),
      'GET /api/v1/getNextInvoiceNumber': () =>
        envelope({ number: state.created && !state.deleted ? '0000000524' : '0000000523' }),
      'GET /api/v1/customers': () => keyedEnvelope([{ id: 120001, name: 'КРИПТОАПС ЕООД', identifier: '204918876' }]),
      'POST /api/v1/createInvoice': (req: RecordedRequest) => {
        state.created = req.body as Record<string, unknown>;
        return envelope({ id: 1626747, number: '0000000523' });
      },
      'PATCH /api/v1/editInvoice/1626747': (req: RecordedRequest) => {
        state.created = { ...(state.created ?? {}), ...(req.body as Record<string, unknown>) };
        return envelope('[Success]');
      },
      'PATCH /api/v1/setInvoiceStatus/1626747': (req: RecordedRequest) => {
        state.paid = (req.body as Record<string, unknown>).set_as_paid === 1;
        return envelope('[Success]');
      },
      'GET /api/v1/invoices/1626747/getInvoicePDF': () => ({
        bytes: new Uint8Array(Buffer.from('%PDF-1.7 test')),
        headers: { 'content-type': 'application/pdf' },
      }),
      'GET /api/v1/invoice/1626747/email': (req: RecordedRequest) => {
        state.emails.push(req.query.email!);
        return envelope('[Success]');
      },
      'GET /api/v1/getInvoices': () => {
        if (!state.created || state.deleted) return keyedEnvelope([]);
        const items = (state.created.items as Array<Record<string, unknown>>) ?? [];
        const net = items.reduce((s, i) => s + Number(i.quantity) * Number(i.price), 0);
        return keyedEnvelope([
          invoiceRecord({
            id: 1626747,
            number: '0000000523',
            amount: net,
            vat_value: (net * 0.2).toFixed(2),
            total_amount_in_default_currency: net * 1.2,
            status: state.paid ? 'Paid' : 'Unpaid',
            status_id: state.paid ? 4 : 1,
            items,
          }),
        ]);
      },
      'GET /api/v1/getInvoicesByNumber': () =>
        envelope(
          state.created && !state.deleted
            ? [{ id: 1626747, number: '0000000523', type: 1, has_accounting: false }]
            : [],
        ),
      'DELETE /api/v1/deleteInvoice': () => {
        state.deleted = true;
        return envelope('[Success]');
      },
    };
    return { routes, state };
  }

  const invoiceArgsFor = (quantity: number) => ({
    customer: { name: 'Криптоапс ЕООД', eik: '204918876', vat_number: 'BG204918876' },
    prices_include_vat: false,
    vat_rate: 20,
    payment_method: 'bank_transfer',
    categories: ['test'],
    lines: [{ name: 'Тестова услуга', description: 'Тест', quantity, unit_price: 10, kind: 'service' }],
  });

  it('creates, edits, marks paid, e-mails and deletes an invoice', async () => {
    const { routes, state } = lifecycleRoutes();
    const { client } = await connect({ routes });

    const created = await client.callTool({ name: 'nula_create_invoice', arguments: invoiceArgsFor(1) });
    expect(created.structuredContent).toMatchObject({ id: 1626747, number: '0000000523' });

    const readBack = await client.callTool({
      name: 'nula_search_invoices',
      arguments: { number: '523', response_format: 'detailed' },
    });
    expect(readBack.structuredContent).toMatchObject({ items: [{ total: 12, lines: [{ quantity: 1 }] }] });

    const edited = await client.callTool({
      name: 'nula_update_invoice',
      arguments: { invoice_id: 1626747, ...invoiceArgsFor(2) },
    });
    expect(edited.isError).toBeFalsy();
    const afterEdit = await client.callTool({ name: 'nula_search_invoices', arguments: { number: '523' } });
    expect(afterEdit.structuredContent).toMatchObject({ items: [{ total: 24 }] });

    await client.callTool({
      name: 'nula_update_invoice_metadata',
      arguments: { invoice_id: 1626747, number: '523', is_paid: true, is_sent: false },
    });
    const afterPaid = await client.callTool({ name: 'nula_search_invoices', arguments: { number: '523' } });
    expect(afterPaid.structuredContent).toMatchObject({ items: [{ payment_status: 'paid', is_paid: true }] });

    const pdf = await client.callTool({
      name: 'nula_get_invoice_pdf',
      arguments: { invoice_id: 1626747, number: '523' },
    });
    expect((pdf.structuredContent as { size_bytes: number }).size_bytes).toBeGreaterThan(0);

    const mail = await client.callTool({
      name: 'nula_email_invoice',
      arguments: { invoice_id: 1626747, to: 'martin@encorp.io', language: 'bg' },
    });
    expect(mail.isError).toBeFalsy();
    expect(state.emails).toEqual(['martin@encorp.io']);

    const deleted = await client.callTool({ name: 'nula_delete_last_invoice', arguments: { expected_number: '523' } });
    expect(deleted.isError).toBeFalsy();
    expect(state.deleted).toBe(true);
    const gone = await client.callTool({ name: 'nula_search_invoices', arguments: { number: '523' } });
    expect(gone.structuredContent).toMatchObject({ items: [] });
  });

  it('refuses to delete an invoice that is already posted to accounting', async () => {
    const { routes, state } = lifecycleRoutes();
    const { client } = await connect({
      routes: {
        ...routes,
        'GET /api/v1/getInvoicesByNumber': () =>
          envelope([{ id: 1626747, number: '0000000523', type: 1, has_accounting: true }]),
      },
    });
    await client.callTool({ name: 'nula_create_invoice', arguments: invoiceArgsFor(1) });
    const res = await client.callTool({ name: 'nula_delete_last_invoice', arguments: { expected_number: '523' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/posted to accounting/);
    expect(state.deleted).toBe(false);
  });
});

describe('read tools', () => {
  it('maps invoice search filters to the nula.bg query', async () => {
    const { client, api } = await connect({
      routes: {
        'GET /api/v1/getInvoices': () =>
          keyedEnvelope([invoiceRecord({ status: 'Paid', status_id: 4 })], {
            current_page: 1,
            next_page: 2,
            last_page: 2,
          }),
      },
    });
    const result = await client.callTool({
      name: 'nula_search_invoices',
      arguments: {
        date_from: '2026-09-01',
        date_to: '2026-09-30',
        document_type: 'credit_note',
        customer_eik: '204733952',
      },
    });
    expect(api.calls[0]?.query).toEqual({
      daterange: '2026-09-01_2026-09-30',
      type: '3',
      identifier: '204733952',
    });
    expect(result.structuredContent).toMatchObject({
      has_more: true,
      items: [{ number: '0000000124', net: 600, vat: 120, total: 720, is_paid: true, payment_status: 'paid' }],
    });
  });

  it('looks a document up by number through the getInvoices filter (the full record)', async () => {
    const { client, api } = await connect({
      routes: { 'GET /api/v1/getInvoices': () => keyedEnvelope([invoiceRecord()]) },
    });
    const result = await client.callTool({ name: 'nula_search_invoices', arguments: { number: '124' } });
    expect(api.calls[0]?.path).toBe('/api/v1/getInvoices');
    expect(api.calls[0]?.query).toEqual({ number: '0000000124' });
    expect(result.structuredContent).toMatchObject({
      items: [{ number: '0000000124', lines: [{ name: 'Консултации', quantity: 10, unit_price: 60 }] }],
    });
  });

  it('falls back to the bills list when /ocr/bill/{id} answers 404 (non-OCR bill)', async () => {
    const billRecord = {
      id: 1967475,
      number: '0000005123',
      type: 1,
      vendor: { id: 4, name: 'Доставчик ООД', identifier: '204733952' },
      amount: 100,
      vat_value: '20.00',
      vat_amount: 20,
      currency_code: 'EUR',
      default_currency_code: 'EUR',
      price_type: 'without_vat',
      status: 'Paid',
      billed_at: '2026-09-01',
      created_at: '2026-09-01T09:00:00.000000Z',
      items: [{ id: 1, name: 'Хартия', quantity: 10, price: 10, vat_amount: 20, vat_type: 1 }],
    };
    const { client, api } = await connect({
      routes: {
        // nula.bg answers 404 here for bills that were not created by OCR.
        'GET /api/v1/ocr/bill/1967475': () => ({ status: 404, json: { statusCode: 404, message: 'Bill not found' } }),
        'GET /api/v1/bills': () => keyedEnvelope([billRecord]),
      },
    });
    const result = await client.callTool({ name: 'nula_search_bills', arguments: { bill_id: 1967475 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      id: 1967475,
      number: '0000005123',
      supplier: { name: 'Доставчик ООД' },
      net: 100,
      vat: 20,
      total: 120,
      is_paid: true,
      lines: [{ name: 'Хартия', quantity: 10, unit_price: 10 }],
    });
    expect(api.calls.map((c) => c.path)).toEqual(['/api/v1/ocr/bill/1967475', '/api/v1/bills']);
  });

  it('says so when the bill id is nowhere to be found', async () => {
    const { client } = await connect({
      routes: {
        'GET /api/v1/ocr/bill/42': () => ({ status: 404, json: { statusCode: 404, message: 'Bill not found' } }),
        'GET /api/v1/bills': () => keyedEnvelope([]),
      },
    });
    const result = await client.callTool({ name: 'nula_search_bills', arguments: { bill_id: 42 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not created by OCR/);
  });

  it('lists bank accounts from the nested array nula.bg returns', async () => {
    const { client } = await connect({
      routes: {
        'GET /api/v1/getBanks': () =>
          envelope([
            [
              {
                id: 7,
                name: 'ДСК',
                IBAN: 'BG80BNBG96611020345678',
                BIC: 'STSABGSF',
                balance: 1234.5,
                currency_code: 'EUR',
                is_default: true,
                enabled: true,
              },
              {
                id: 8,
                name: 'ДСК USD',
                IBAN: 'BG18RZBB91550123456789',
                balance: 10,
                currency_code: 'USD',
                is_default: false,
                enabled: true,
              },
            ],
          ]),
      },
    });
    const result = await client.callTool({ name: 'nula_list_bank_accounts', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      items: [
        { id: 7, iban: 'BG80BNBG96611020345678', bic: 'STSABGSF', currency: 'EUR', balance: 1234.5, is_default: true },
        { id: 8, currency: 'USD' },
      ],
    });
  });

  it('saves an invoice PDF to the download folder', async () => {
    const pdf = new Uint8Array(Buffer.from('%PDF-1.7 test'));
    const { client, config } = await connect({
      routes: {
        'GET /api/v1/invoices/5/getInvoicePDF': () => ({ bytes: pdf, headers: { 'content-type': 'application/pdf' } }),
      },
    });
    const result = await client.callTool({
      name: 'nula_get_invoice_pdf',
      arguments: { invoice_id: 5, number: '12', language: 'en' },
    });
    const saved = (result.structuredContent as { path: string }).path;
    expect(saved.startsWith(config.downloadDir)).toBe(true);
    expect(saved.endsWith('0000000012-en.pdf')).toBe(true);
    expect(readFileSync(saved).toString()).toBe('%PDF-1.7 test');
    expect((result.content as Array<{ type: string }>).some((c) => c.type === 'resource_link')).toBe(true);
  });

  it('reads bill details including top-level items', async () => {
    const { client } = await connect({
      routes: {
        'GET /api/v1/ocr/bill/3': () => ({
          json: {
            statusCode: 200,
            message: 'OK',
            data: {
              invoice_number: '123456',
              date: '09.05.2023',
              vendor_identifier: '123456789',
              total_amount: 600,
              currency: 'EUR',
            },
            items: [{ code: '001', description: 'Хартия', unit: 'бр.', quantity: 10, unit_price: 15, amount: 150 }],
          },
        }),
      },
    });
    const result = await client.callTool({ name: 'nula_search_bills', arguments: { bill_id: 3 } });
    expect(result.structuredContent).toMatchObject({
      id: 3,
      number: '123456',
      issue_date: '2023-05-09',
      supplier: { eik: '123456789' },
      total: 600,
      lines: [{ sku: '001', quantity: 10, amount: 150 }],
    });
  });

  it('builds a receivables report with aging buckets', async () => {
    const { client } = await connect({
      routes: {
        'GET /api/v1/getInvoices': (req) =>
          req.query.page === '1'
            ? keyedEnvelope([
                invoiceRecord({ id: 1, number: '0000000001', due_at: '2026-08-01', status: 'Unpaid' }),
                invoiceRecord({
                  id: 2,
                  number: '0000000002',
                  due_at: '2026-09-30',
                  status: 'Unpaid',
                  amount: 40,
                  vat_value: '10.00',
                }),
                invoiceRecord({ id: 3, number: '0000000003', due_at: '2026-08-01', status: 'Paid' }),
              ])
            : keyedEnvelope([]),
      },
    });
    const result = await client.callTool({ name: 'nula_receivables_report', arguments: { as_of: '2026-09-22' } });
    expect(result.structuredContent).toMatchObject({
      total_outstanding: 770,
      aging: { '31-60': 720, current: 50 },
      coverage: { complete: true },
    });
  });
});
