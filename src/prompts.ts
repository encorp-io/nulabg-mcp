import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Config } from './config.ts';

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

export function registerPrompts(server: McpServer, config: Config): void {
  const has = (t: string) => config.toolsets.has(t as never);

  if (has('invoices') && !config.readOnly) {
    server.registerPrompt(
      'issue-invoice',
      {
        title: 'Издай фактура',
        description: 'Guided invoice creation: look up the customer, pick items, preview, confirm, create, send.',
        argsSchema: z.object({
          customer: z.string().describe('Customer EIK, VAT number or name'),
          description: z.string().describe('What to invoice, e.g. "10 часа консултации по 60 € без ДДС"'),
        }),
      },
      ({ customer, description }) =>
        user(
          `Издай документ в nula.bg за клиент "${customer}": ${description}.\n` +
            'Стъпки: 1) nula_lookup_company (и nula_search_customers) за точното име и ЕИК; ' +
            '2) nula_search_items за съществуващи артикули и цени; ' +
            '3) ако не е ясно дали цените са с или без ДДС, начинът на плащане или падежът, попитай ме; ' +
            '4) nula_create_invoice с preview_only: true и ми покажи номера, редовете и сумите; ' +
            '5) създай само след изрично потвърждение; 6) предложи PDF (nula_get_invoice_pdf) или имейл (nula_email_invoice).',
        ),
    );
  }

  if (has('ocr') && !config.readOnly) {
    server.registerPrompt(
      'process-receipts',
      {
        title: 'Обработи документи с OCR',
        description: 'Send scanned bills/invoices to OCR and review what was recognised.',
        argsSchema: z.object({
          folder: z.string().optional().describe('Local folder with PDF/JPG/PNG files'),
          document_type: z
            .enum(['bill', 'invoice'])
            .optional()
            .describe('bill = покупки (default), invoice = продажби'),
        }),
      },
      ({ folder, document_type }) =>
        user(
          `Обработи документи с OCR в nula.bg като ${document_type === 'invoice' ? 'продажби' : 'покупки'}` +
            `${folder ? ` от папка ${folder}` : ''}.\n` +
            '1) Провери квотата с nula_ocr_status. 2) Качи файловете с nula_ocr_upload (до 10 наведнъж). ' +
            '3) Покажи ми таблица: доставчик, номер, дата, сума, ДДС, статус на разпознаването. ' +
            '4) Посочи съмнителните (липсващ ЕИК, сума 0, неуспешно разпознаване). ' +
            '5) Предложи категории и ги задай с nula_update_bill_categories само след потвърждение.',
        ),
    );
  }

  if (has('invoices')) {
    server.registerPrompt(
      'month-end-review',
      {
        title: 'Преглед за месечно приключване',
        description: 'Sales, purchases, unpaid invoices, pending OCR and unmatched bank transactions for a month.',
        argsSchema: z.object({
          month: z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .describe('Month as YYYY-MM'),
        }),
      },
      ({ month }) =>
        user(
          `Направи преглед за месец ${month} в nula.bg:\n` +
            '- обобщение на продажби и покупки (nula_period_summary);\n' +
            '- неплатени и просрочени фактури (nula_receivables_report);\n' +
            '- висящи OCR документи (nula_ocr_status с status "processing" или "failed");\n' +
            '- входящи банкови движения без съпоставка (nula_list_bank_accounts → nula_match_bank_transactions).\n' +
            'Завърши с кратък списък с действия. Не променяй нищо без моето потвърждение.',
        ),
    );

    server.registerPrompt(
      'collect-overdue',
      {
        title: 'Просрочени вземания',
        description: 'Find overdue invoices and draft reminder e-mails (nothing is sent automatically).',
        argsSchema: z.object({
          min_days_overdue: z.string().regex(/^\d+$/).optional().describe('Minimum days overdue (default 30)'),
        }),
      },
      ({ min_days_overdue }) =>
        user(
          `Намери фактурите, просрочени с поне ${min_days_overdue ?? '30'} дни (nula_receivables_report), групирани по клиент. ` +
            'За всеки клиент напиши учтива чернова на напомняне на български с номерата, сумите и падежите. ' +
            'НЕ изпращай нищо: само черновите.',
        ),
    );
  }
}
