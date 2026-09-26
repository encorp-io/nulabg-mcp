import { describe, expect, it } from 'vitest';
import { addDays, isoToBg, isValidIsoDate, normalizeDate, resolveRange, todaySofia } from '../../src/mappers/dates.ts';
import { buildBillPayload, buildInvoicePayload, type InvoiceInput } from '../../src/mappers/documents.ts';
import { isValidEik, isValidIban, padDocNumber } from '../../src/mappers/identifiers.ts';
import { formatMoney, round2 } from '../../src/mappers/money.ts';
import { testConfig } from '../helpers.ts';

describe('dates', () => {
  it('converts ISO to the Bulgarian format nula.bg expects', () => {
    expect(isoToBg('2026-09-02')).toBe('02.09.2026');
  });
  it('validates calendar dates', () => {
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2028-02-29')).toBe(true);
  });
  it('uses the Sofia calendar day, not UTC', () => {
    // 22:30 UTC on 21 Sep is already 22 Sep in Sofia (UTC+3 in summer).
    expect(todaySofia(new Date('2026-09-21T22:30:00Z'))).toBe('2026-09-22');
  });
  it('normalises nula.bg date formats', () => {
    expect(normalizeDate('09.05.2023')).toBe('2023-05-09');
    expect(normalizeDate('2026-01-31 10:00:00')).toBe('2026-01-31');
    expect(normalizeDate('2026-01-31T23:30:00.000000Z')).toBe('2026-02-01');
    expect(normalizeDate('')).toBeUndefined();
  });
  it('fills a half-open range', () => {
    expect(resolveRange('2026-03-01', undefined, '2026-09-22')).toEqual({ from: '2026-03-01', to: '2026-09-22' });
    expect(resolveRange(undefined, '2026-05-31')).toEqual({ from: '2026-01-01', to: '2026-05-31' });
    expect(resolveRange(undefined, undefined)).toBeUndefined();
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });
});

describe('identifiers and money', () => {
  it('validates EIK check digits', () => {
    expect(isValidEik('204733952')).toBe(true);
    expect(isValidEik('204733953')).toBe(false);
    expect(isValidEik('12345')).toBe(false);
  });
  it('validates IBANs', () => {
    expect(isValidIban('BG80 BNBG 9661 1020 3456 78')).toBe(true);
    expect(isValidIban('BG80BNBG96611020345679')).toBe(false);
  });
  it('pads document numbers to 10 digits', () => {
    expect(padDocNumber('124')).toBe('0000000124');
    expect(() => padDocNumber('12345678901')).toThrow();
  });
  it('rounds and formats money the Bulgarian way', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(formatMoney(1234.5, 'EUR')).toBe('1 234,50 €');
  });
});

const base: InvoiceInput = {
  customer: { name: 'Клауд ООД', eik: '204733952' },
  prices_include_vat: false,
  payment_method: 'bank_transfer',
  categories: ['consulting'],
  issue_date: '2026-09-22',
  lines: [{ name: 'Консултации', quantity: 10, unit_price: 60, kind: 'service' }],
};

describe('buildInvoicePayload', () => {
  const config = testConfig();

  it('maps MCP fields to nula.bg fields', () => {
    const { payload, errors, totals } = buildInvoicePayload({ ...base, number: '124', due_date: '2026-10-07' }, config);
    expect(errors).toEqual([]);
    expect(payload).toMatchObject({
      identifier: '204733952',
      bulgarian_recipient: 1,
      recipient_company_name: 'Клауд ООД',
      number: '0000000124',
      type: 1,
      created_at: '22.09.2026',
      invoiced_at: '22.09.2026',
      due_at: '07.10.2026',
      currency_code: 'EUR',
      payment_method: 1,
      price_type: 0,
      vat_amount: 20,
      different_vats: 0,
      tags: ['consulting'],
      items: [{ name: 'Консултации', description: 'Консултации', item_type: 3, quantity: 10, price: 60 }],
    });
    expect(totals).toMatchObject({ net: 600, vat: 120, total: 720 });
  });

  it('computes totals for prices that include VAT and mixed rates', () => {
    const { payload, totals } = buildInvoicePayload(
      {
        ...base,
        prices_include_vat: true,
        lines: [
          { name: 'Нощувка', quantity: 2, unit_price: 109, kind: 'service', vat_rate: 9 },
          { name: 'Минибар', quantity: 1, unit_price: 12, kind: 'goods' },
        ],
      },
      config,
    );
    expect(payload.different_vats).toBe(1);
    expect((payload.items as Array<Record<string, unknown>>)[0]?.vat_amount).toBe(9);
    expect(totals.by_rate).toEqual([
      { vat_rate: 20, net: 10, vat: 2, gross: 12 },
      { vat_rate: 9, net: 200, vat: 18, gross: 218 },
    ]);
    expect(totals.total).toBe(230);
  });

  it('requires a zero-VAT reason and a VAT number for foreign customers', () => {
    const { errors } = buildInvoicePayload(
      { ...base, customer: { name: 'ACME GmbH', is_bulgarian: false }, vat_rate: 0 },
      config,
    );
    expect(errors.join('\n')).toMatch(/customer.vat_number is required/);
    expect(errors.join('\n')).toMatch(/zero_vat_reason is required/);
  });

  it('infers a foreign customer from the VAT prefix', () => {
    const { payload, errors } = buildInvoicePayload(
      { ...base, customer: { name: 'ACME GmbH', vat_number: 'de 123 456 789' }, vat_rate: 0, zero_vat_reason: 19 },
      config,
    );
    expect(errors).toEqual([]);
    expect(payload).toMatchObject({ bulgarian_recipient: 0, recipient_vat: 'DE123456789', no_vat_reason: 19 });
  });

  it('requires categories unless a default is configured', () => {
    expect(buildInvoicePayload({ ...base, categories: undefined }, config).errors.join()).toMatch(/categories/);
    const withDefault = testConfig({ NULA_DEFAULT_INVOICE_CATEGORY: 'sales' });
    expect(buildInvoicePayload({ ...base, categories: undefined }, withDefault).payload.tags).toEqual(['sales']);
  });

  it('warns about BGN after the euro changeover and a late issue date', () => {
    const { warnings } = buildInvoicePayload({ ...base, currency: 'BGN', tax_event_date: '2026-09-01' }, config);
    expect(warnings.join('\n')).toMatch(/EUR since 2026/);
    expect(warnings.join('\n')).toMatch(/within 5 days/);
  });

  it('rejects an invalid IBAN and a due date before the issue date', () => {
    const { errors } = buildInvoicePayload({ ...base, iban: 'BG00XXXX', due_date: '2026-09-01' }, config);
    expect(errors.join('\n')).toMatch(/not a valid IBAN/);
    expect(errors.join('\n')).toMatch(/due_date cannot be before/);
  });
});

describe('buildBillPayload', () => {
  it('maps purchase lines, tax credit and a чл.117 protocol', () => {
    const { payload, errors } = buildBillPayload(
      {
        supplier: { name: 'Google Ireland', vat_number: 'IE6388047V' },
        number: '5123',
        issue_date: '2026-09-01',
        tax_event_date: '2026-09-01',
        vat_period: '2026-09',
        prices_include_vat: false,
        vat_rate: 20,
        payment_method: 'card',
        lines: [
          {
            name: 'Workspace',
            quantity: 1,
            unit_price: 100,
            unit: 'бр.',
            expense_account: 602,
            track_inventory: false,
            tax_credit: 'full',
            vat_sum: 20,
          },
        ],
        protocol: { reason: 4 },
      },
      testConfig(),
      'https://example.test/cb',
    );
    expect(errors).toEqual([]);
    expect(payload).toMatchObject({
      callback_url: 'https://example.test/cb',
      bulgarian_recipient: 0,
      recipient_vat: 'IE6388047V',
      number: '0000005123',
      billed_at: '01.09.2026',
      vat_period: '2026-09',
      payment_method: 3,
      different_vats: 1,
      protocol_reason: 4,
      items: [{ purchase_account_code: 602, tracked: 0, unit_name: 'бр.', vat_type: 1, vat_amount: 20 }],
    });
  });
});
