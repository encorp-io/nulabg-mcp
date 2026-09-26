import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import {
  DOCUMENT_TYPE_LABELS_BG,
  INVOICE_DOCUMENT_TYPES,
  INVOICE_PAYMENT_METHODS,
  LINE_KIND_ACCOUNTS,
  TAX_CREDIT_LABELS,
  VAT_RATES,
} from './mappers/enums.ts';
import { OSS_COUNTRIES, PROTOCOL_REASONS, ZERO_VAT_REASONS } from './nula/reference-data.ts';
import type { ToolEnv } from './tools/define.ts';

const json = (uri: string, data: unknown) => ({
  contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 1) }],
});

export function registerResources(server: McpServer, env: ToolEnv): void {
  server.registerResource(
    'zero-vat-reasons',
    'nula://reference/zero-vat-reasons',
    {
      title: 'Основания за 0% ДДС',
      description: 'Codes 1–57 for zero_vat_reason (legal basis for a 0% VAT rate under ЗДДС).',
      mimeType: 'application/json',
    },
    (uri) => json(uri.href, ZERO_VAT_REASONS),
  );

  server.registerResource(
    'protocol-reasons',
    'nula://reference/protocol-reasons',
    {
      title: 'Основания за протокол по чл.117 ЗДДС',
      description: 'Codes 1–32 for protocol.reason on purchase bills.',
      mimeType: 'application/json',
    },
    (uri) => json(uri.href, PROTOCOL_REASONS),
  );

  server.registerResource(
    'enums',
    'nula://reference/enums',
    {
      title: 'nula.bg value lists',
      description: 'Document types, payment methods, line kinds, tax credit types, VAT rates and OSS countries.',
      mimeType: 'application/json',
    },
    (uri) =>
      json(uri.href, {
        document_types: Object.fromEntries(
          Object.keys(INVOICE_DOCUMENT_TYPES).map((k) => [k, DOCUMENT_TYPE_LABELS_BG[k]]),
        ),
        payment_methods: Object.keys(INVOICE_PAYMENT_METHODS),
        line_kinds: LINE_KIND_ACCOUNTS,
        tax_credit: TAX_CREDIT_LABELS,
        vat_rates: VAT_RATES,
        oss_countries: OSS_COUNTRIES,
      }),
  );

  server.registerResource(
    'invoice-pdf',
    new ResourceTemplate('nula://invoices/{id}/pdf{?lang}', { list: undefined }),
    { title: 'Invoice PDF', description: 'PDF of a sales invoice by internal id.', mimeType: 'application/pdf' },
    async (uri, variables, ctx) => {
      const id = Number(variables.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid invoice id in ${uri.href}`);
      const lang = variables.lang === 'en' ? 'en' : env.config.defaultLanguage;
      const pdf = await env.clientFor().getBinary(`/api/v1/invoices/${id}/getInvoicePDF`, {
        query: { in_english: lang === 'en' ? 1 : 0 },
        signal: ctx.mcpReq.signal,
      });
      return {
        contents: [{ uri: uri.href, mimeType: 'application/pdf', blob: Buffer.from(pdf.bytes).toString('base64') }],
      };
    },
  );
}
