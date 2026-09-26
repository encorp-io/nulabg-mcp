/** Readable MCP enum values ↔ nula.bg integer codes. */

function invert<K extends string>(map: Record<K, number>): Record<number, K> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k])) as Record<number, K>;
}

export const INVOICE_DOCUMENT_TYPES = {
  proforma: 0,
  invoice: 1,
  debit_note: 2,
  credit_note: 3,
  protocol: 9,
  protocol_personal_use: 10,
  protocol_vat_charge: 11,
} as const;
export type InvoiceDocumentType = keyof typeof INVOICE_DOCUMENT_TYPES;
export const INVOICE_DOCUMENT_TYPE_BY_CODE = invert(INVOICE_DOCUMENT_TYPES);

export const BILL_DOCUMENT_TYPES = { proforma: 0, invoice: 1, debit_note: 2, credit_note: 3, protocol: 9 } as const;
export type BillDocumentType = keyof typeof BILL_DOCUMENT_TYPES;

/** Filter values accepted by `getInvoices?type=`. */
export const INVOICE_FILTER_TYPES = { proforma: 0, invoice: 1, debit_note: 2, credit_note: 3 } as const;

export const INVOICE_PAYMENT_METHODS = {
  bank_transfer: 1,
  cash: 2,
  card: 3,
  cash_on_delivery: 4,
  postal_money_order: 5,
} as const;
export type InvoicePaymentMethod = keyof typeof INVOICE_PAYMENT_METHODS;

export const BILL_PAYMENT_METHODS = { bank_transfer: 1, cash: 2, card: 3 } as const;

/** `item_type` on sales lines and the revenue account it posts to. */
export const LINE_KINDS = { product: 1, goods: 2, service: 3, advance: 4 } as const;
export type LineKind = keyof typeof LINE_KINDS;
export const LINE_KIND_ACCOUNTS: Record<LineKind, string> = {
  product: '701 Приходи от продажба на продукция',
  goods: '702 Приходи от продажба на стоки',
  service: '703 Приходи от продажба на услуги',
  advance: '412 Клиенти по аванси',
};

/** `vat_type` on purchase lines: данъчен кредит (tax credit). */
export const TAX_CREDIT_TYPES = { full: 1, partial: 2, none: 3, tro: 4 } as const;
export const TAX_CREDIT_LABELS: Record<keyof typeof TAX_CREDIT_TYPES, string> = {
  full: 'ПДК: пълен данъчен кредит',
  partial: 'ЧДК: частичен данъчен кредит',
  none: 'БДК: без данъчен кредит',
  tro: 'ТРО (VAT sum is always 0)',
};

export const VAT_RATES = [20, 9, 0] as const;
export type VatRate = (typeof VAT_RATES)[number];

export const DOCUMENT_TYPE_LABELS_BG: Record<string, string> = {
  proforma: 'проформа',
  invoice: 'фактура',
  debit_note: 'дебитно известие',
  credit_note: 'кредитно известие',
  protocol: 'протокол',
  protocol_personal_use: 'протокол за лични нужди',
  protocol_vat_charge: 'протокол за начисляване на ДДС',
};
