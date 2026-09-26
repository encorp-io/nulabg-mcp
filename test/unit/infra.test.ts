import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { FileInputError, isPrivateAddress, loadFile, sniffMime } from '../../src/files.ts';
import { redact } from '../../src/logger.ts';
import { INVOICE_FIELD_MAP } from '../../src/mappers/documents.ts';
import { NulaApiError, NulaClient } from '../../src/nula/client.ts';
import { describeError, mapFieldName } from '../../src/nula/errors.ts';
import {
  extractList,
  normalizeBankAccount,
  normalizeCompanyLookup,
  normalizeInvoice,
  normalizeTransaction,
  stripHeavy,
} from '../../src/nula/normalize.ts';
import { fakeNula, invoiceRecord, testConfig } from '../helpers.ts';

describe('config', () => {
  it('defaults to EUR, Bulgarian and the standard toolsets', () => {
    const c = loadConfig({ NULA_API_KEY: 'k' });
    expect(c.defaultCurrency).toBe('EUR');
    expect(c.defaultLanguage).toBe('bg');
    expect(c.toolsets.has('invoices')).toBe(true);
    expect(c.toolsets.has('nra')).toBe(false);
    expect(c.profiles).toEqual({ default: 'k' });
  });
  it('is read-only unless NULA_READ_ONLY is explicitly false (fails closed)', () => {
    expect(loadConfig({ NULA_API_KEY: 'k' }).readOnly).toBe(true);
    for (const off of ['false', 'FALSE', '0', 'no', 'off', ' false ']) {
      expect(loadConfig({ NULA_API_KEY: 'k', NULA_READ_ONLY: off }).readOnly).toBe(false);
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an unexpanded Claude Desktop placeholder
    const unexpandedPlaceholder = '${user_config.read_only}';
    for (const on of ['true', '1', '', 'ture', 'flase', unexpandedPlaceholder]) {
      expect(loadConfig({ NULA_API_KEY: 'k', NULA_READ_ONLY: on }).readOnly).toBe(true);
    }
  });

  it('parses profiles and rejects unknown toolsets', () => {
    const c = loadConfig({ NULA_PROFILES: '{"firma-a":"k1","firma-b":"k2"}', NULA_DEFAULT_PROFILE: 'firma-b' });
    expect(c.defaultProfile).toBe('firma-b');
    expect(() => loadConfig({ NULA_TOOLSETS: 'invoices,payroll' })).toThrow(ConfigError);
    expect(loadConfig({ NULA_TOOLSETS: 'all' }).toolsets.has('noi')).toBe(true);
  });
});

describe('NulaClient', () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  it('sends the bearer token and skips empty query values', async () => {
    const api = fakeNula({ 'GET /api/v1/bills': () => ({ json: { statusCode: 200, data: [] } }) });
    const client = new NulaClient({ apiKey: 'secret', baseUrl: 'https://nula.test', fetch: api.fetch });
    await client.get('/api/v1/bills', { query: { page: 2, name: undefined, number: '' } });
    expect(api.calls[0]?.headers.get('authorization')).toBe('Bearer secret');
    expect(api.calls[0]?.query).toEqual({ page: '2' });
  });

  it('retries GET on 503 but never retries POST', async () => {
    let gets = 0;
    let posts = 0;
    const fetch = (async (_url: string, init: RequestInit) => {
      if (init.method === 'GET') return ++gets < 3 ? json({}, 503) : json({ statusCode: 200, data: 'ok' });
      posts++;
      return json({}, 503);
    }) as typeof globalThis.fetch;
    const client = new NulaClient({ apiKey: 'k', baseUrl: 'https://nula.test', fetch, retryBaseMs: 0 });
    await expect(client.get('/x')).resolves.toMatchObject({ data: 'ok' });
    expect(gets).toBe(3);
    const err = await client.post('/x', { body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(NulaApiError);
    expect(posts).toBe(1);
    expect((err as NulaApiError).outcomeUnknown).toBe(true);
  });

  it('treats an error statusCode inside a 2xx envelope as an error', async () => {
    const fetch = (async () =>
      json({ statusCode: 422, message: 'Invalid', errors: { identifier: ['bad'] } })) as typeof globalThis.fetch;
    const client = new NulaClient({ apiKey: 'k', baseUrl: 'https://nula.test', fetch });
    const err = (await client.get('/x').catch((e) => e)) as NulaApiError;
    expect(err.status).toBe(422);
    expect(describeError(err, INVOICE_FIELD_MAP)).toContain('customer.eik: bad');
  });

  it('explains a 403 from the native endpoints (token not scoped to a team)', async () => {
    const fetch = (async () =>
      json(
        { message: 'This token is not scoped to a team you can access.', statusCode: 403 },
        403,
      )) as typeof globalThis.fetch;
    const client = new NulaClient({ apiKey: 'k', baseUrl: 'https://nula.test', fetch });
    const err = await client.get('/api/native/v1/ocr/quota').catch((e) => e);
    expect(describeError(err)).toMatch(/not scoped to a company \(team\)/);
    expect(describeError(err)).toMatch(/OCR, НАП, НОИ/);
  });

  it('explains an invalid API key (nula.bg answers 401 with statusCode 403 in the body)', async () => {
    const fetch = (async () =>
      json(
        { message: 'Unauthenticated.', statusCode: 403, errors: 'Unauthenticated.' },
        401,
      )) as typeof globalThis.fetch;
    const client = new NulaClient({ apiKey: 'k', baseUrl: 'https://nula.test', fetch });
    const err = await client.get('/x').catch((e) => e);
    expect(describeError(err)).toMatch(/rejected the API key/);
  });
});

describe('error field mapping', () => {
  it('maps nested nula.bg fields back to MCP parameter names', () => {
    expect(mapFieldName('items.2.price', INVOICE_FIELD_MAP)).toBe('lines[2].unit_price');
    expect(mapFieldName('items.0.name', INVOICE_FIELD_MAP)).toBe('lines[0].name');
    expect(mapFieldName('invoiced_at', INVOICE_FIELD_MAP)).toBe('tax_event_date');
  });
});

describe('normalisation', () => {
  it('reads the real keyed list shape of nula.bg', () => {
    const { items, page } = extractList({
      statusCode: 200,
      message: 'OK',
      data: { 0: { id: 1 }, 1: { id: 2 }, current_page: 1, next_page: 2, last_page: 4 },
    });
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(page).toEqual({ page: 1, next_page: 2, last_page: 4, has_more: true });
    expect(extractList({ data: { 0: { id: 1 }, current_page: 4, next_page: null, last_page: 4 } }).page.has_more).toBe(
      false,
    );
  });

  it('flattens the nested array getBanks returns', () => {
    const { items } = extractList({
      statusCode: 200,
      data: [[{ id: 1, IBAN: 'BG80BNBG96611020345678' }, { id: 2 }]],
    });
    expect(items).toHaveLength(2);
    expect(normalizeBankAccount(items[0]!)).toMatchObject({ id: 1, iban: 'BG80BNBG96611020345678' });
  });

  it('still reads a Laravel paginator', () => {
    const { items, page } = extractList({
      statusCode: 200,
      data: { current_page: 1, last_page: 3, per_page: 15, total: 40, data: [{ id: 1 }, { id: 2 }] },
    });
    expect(items).toHaveLength(2);
    expect(page).toEqual({ page: 1, per_page: 15, total: 40, last_page: 3, has_more: true });
  });
  it('does not mistake invoice lines for a list', () => {
    const { items } = extractList({ statusCode: 200, data: { id: 7, number: '1', items: [{ name: 'x' }] } });
    expect(items).toEqual([{ id: 7, number: '1', items: [{ name: 'x' }] }]);
  });
  it('normalises a real invoice record: amount is net, vat_value is the VAT sum', () => {
    const inv = normalizeInvoice(invoiceRecord({ type: 3, status: 'Partially paid', status_id: 5 }));
    expect(inv).toEqual({
      id: 5512,
      number: '0000000124',
      document_type: 'credit_note',
      issue_date: '2026-09-22',
      tax_event_date: '2026-09-22',
      due_date: '2026-10-07',
      customer: {
        id: 81,
        name: 'Пример ООД',
        eik: '204733952',
        vat_number: 'BG204733952',
        city: 'София',
        country: 'България',
      },
      currency: 'EUR',
      net: 600,
      vat: 120,
      total: 720,
      vat_rate: 20,
      has_different_vats: false,
      prices_include_vat: false,
      payment_status: 'partially_paid',
      is_paid: false,
      payment_method: 'bank_transfer',
      vat_period: '2026-09',
    });
  });

  it('keeps foreign-currency totals separate from the company currency', () => {
    const inv = normalizeInvoice(
      invoiceRecord({ currency_code: 'USD', default_currency_code: 'EUR', total_amount_in_default_currency: 621.14 }),
    );
    expect(inv).toMatchObject({
      currency: 'USD',
      net: 600,
      vat: 120,
      total: 720,
      total_in_default_currency: 621.14,
      default_currency: 'EUR',
    });
  });

  it('reads the payment direction from the Bulgarian operation label', () => {
    expect(
      normalizeTransaction({
        id: 1,
        amount: 120,
        operation: 'Кредит',
        value_date: '2026-09-20T00:00:00.000000Z',
        counterparty_name: 'X',
        counterparty_bank_account: 'BG80BNBG96611020345678',
      }),
    ).toEqual({
      id: 1,
      date: '2026-09-20',
      amount: 120,
      direction: 'in',
      counterparty: 'X',
      counterparty_iban: 'BG80BNBG96611020345678',
    });
    expect(normalizeTransaction({ amount: 50, operation: 'Дебит' }).direction).toBe('out');
  });

  it('maps the company lookup, including the Cyrillic "аddress" key', () => {
    expect(
      normalizeCompanyLookup({
        identifier: '204733952',
        name: 'КЛАУД ТЕК ООД',
        legal_form_short: 'ООД',
        vat: true,
        vat_id: 'BG204733952',
        аddress: 'гр. Варна, ул. Примерна 1',
        last_update: '2026-09-01T00:00:00.000000Z',
      }),
    ).toMatchObject({
      name: 'КЛАУД ТЕК ООД',
      eik: '204733952',
      legal_form: 'ООД',
      vat_number: 'BG204733952',
      is_vat_registered: true,
      address: 'гр. Варна, ул. Примерна 1',
    });
  });
  it('strips base64 blobs', () => {
    const out = stripHeavy({ name: 'd.xml', content: 'A'.repeat(5000) }) as Record<string, string>;
    expect(out.content).toMatch(/omitted/);
  });
  it('redacts secrets in logs', () => {
    expect(redact({ Authorization: 'Bearer abc', nested: 'Bearer eyJabc.def' })).toEqual({
      Authorization: '***',
      nested: 'Bearer ***',
    });
  });
});

describe('file inputs', () => {
  const PDF = Buffer.from('%PDF-1.7\n%test');

  it('detects types by magic bytes', () => {
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffMime(Buffer.from('hello'))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('reads files only inside the allowed roots, never hidden ones', async () => {
    const config = testConfig();
    const root = config.fileRoots[0]!;
    writeFileSync(path.join(root, 'invoice.pdf'), PDF);
    mkdirSync(path.join(root, '.secret'));
    writeFileSync(path.join(root, '.secret', 'x.pdf'), PDF);
    writeFileSync(path.join(root, 'notes.txt'), 'hello');
    symlinkSync('/etc/hosts', path.join(root, 'link.pdf'));

    await expect(loadFile({ path: path.join(root, 'invoice.pdf') }, config)).resolves.toMatchObject({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
    });
    await expect(loadFile({ path: path.join(root, '.secret', 'x.pdf') }, config)).rejects.toThrow(/hidden/);
    await expect(loadFile({ path: path.join(root, 'notes.txt') }, config)).rejects.toThrow(/not a PDF/);
    await expect(loadFile({ path: path.join(root, 'link.pdf') }, config)).rejects.toThrow(FileInputError);
    await expect(loadFile({ path: '/etc/hosts' }, config)).rejects.toThrow(/outside the allowed folders/);
  });

  it('accepts base64 and data URIs', async () => {
    const file = await loadFile(
      { base64: `data:application/pdf;base64,${PDF.toString('base64')}`, filename: 'a.pdf' },
      testConfig(),
    );
    expect(file.mimeType).toBe('application/pdf');
  });

  it('refuses private and local addresses', async () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    await expect(loadFile({ url: 'https://127.0.0.1/a.pdf' }, testConfig())).rejects.toThrow(/private or local/);
    await expect(loadFile({ url: 'http://example.com/a.pdf' }, testConfig())).rejects.toThrow(/https/);
  });
});
