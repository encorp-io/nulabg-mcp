import { z } from 'zod';
import { isValidIsoDate } from '../mappers/dates.ts';
import { DOC_NUMBER_PATTERN, EIK_PATTERN } from '../mappers/identifiers.ts';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isValidIsoDate, 'Not a valid calendar date');

export const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const docNumber = z
  .string()
  .regex(DOC_NUMBER_PATTERN, 'Up to 10 digits, e.g. "124" or "0000000124"')
  .describe('Document number (up to 10 digits; leading zeros optional)');

export const eik = z
  .string()
  .regex(EIK_PATTERN, 'EIK must have 9 or 13 digits')
  .describe('Bulgarian EIK/BULSTAT (ЕИК)');

export const vatNumber = z
  .string()
  .min(4)
  .max(20)
  .describe('VAT number with country prefix, e.g. BG123456789 or DE123456789');

export const page = z.number().int().min(1).optional().describe('Page number, starting at 1');

export const vatRate = z.literal([20, 9, 0]).describe('VAT rate in percent (ставка ДДС)');

export const responseFormat = z
  .enum(['concise', 'detailed'])
  .optional()
  .describe('"concise" (default) returns key fields; "detailed" adds lines and the raw nula.bg record');

export const language = z.enum(['bg', 'en']).optional().describe('Document language (default from configuration)');

export const idParam = (what: string) => z.number().int().positive().describe(`nula.bg internal id of the ${what}`);

export const categories = z
  .array(z.string().min(1))
  .min(1)
  .describe('Categories (категории/тагове) in nula.bg, e.g. ["consulting"]. Replaces existing ones.');

export const counterpartySchema = z.object({
  name: z.string().min(1).describe('Legal name exactly as registered (use nula_lookup_company)'),
  eik: eik.optional(),
  vat_number: vatNumber.optional(),
  no_vat_number: z.boolean().optional().describe('Set true for a foreign counterparty that has no VAT number at all'),
  is_bulgarian: z
    .boolean()
    .optional()
    .describe('Bulgarian counterparty? Inferred: true when eik is given or vat_number starts with BG'),
});

export const customerSchema = counterpartySchema
  .extend({
    address: z.string().optional().describe('Street address (used only when nula.bg creates a new customer)'),
    post_code: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional().describe('Country name, e.g. "България" or "Germany"'),
  })
  .describe('Customer (клиент/контрагент). Created in nula.bg automatically if it does not exist.');

export const deliverySchema = z
  .enum(['file', 'embed'])
  .optional()
  .describe('"file" (default) saves to the download folder and returns the path; "embed" returns the file inline');
