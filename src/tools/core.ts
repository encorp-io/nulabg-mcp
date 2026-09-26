import { z } from 'zod';
import { isBulgarianVat, isValidEik, normalizeVat } from '../mappers/identifiers.ts';
import { isObj, normalizeCompanyLookup, stripHeavy, stripUndefined, unwrap } from '../nula/normalize.ts';
import { defineTool, fail, ok } from './define.ts';
import { eik, vatNumber } from './schemas.ts';

export const lookupCompany = defineTool({
  name: 'nula_lookup_company',
  toolset: 'core',
  title: 'Look up a company (ЕИК / VAT)',
  description:
    'Look up a company (фирма) by Bulgarian EIK (ЕИК/БУЛСТАТ), EU VAT number or name via nula.bg ' +
    '(Commercial Register / VIES). Use it BEFORE creating an invoice or bill for a counterparty you have not seen, ' +
    'to get the exact legal name and VAT number. Never invent an EIK.',
  kind: 'read',
  annotations: { openWorldHint: true },
  input: z.object({
    eik: eik.optional(),
    vat_number: vatNumber.optional(),
    name: z.string().min(2).optional().describe('Company name (partial names may work for Bulgarian companies)'),
  }),
  async run(args, { client, ctx }) {
    if (!args.eik && !args.vat_number && !args.name) return fail('Provide eik, vat_number or name.');
    const vat = args.vat_number ? normalizeVat(args.vat_number) : undefined;
    const bulgarian = args.eik ? true : vat ? isBulgarianVat(vat) : true;
    const body = await client.get('/api/v1/getCompanyDetails', {
      query: {
        bulgarian_recipient: bulgarian ? 1 : 0,
        identifier: args.eik ?? (vat && bulgarian ? vat.slice(2) : undefined),
        company_name: args.name,
        recipient_vat: vat,
      },
      signal: ctx.mcpReq.signal,
    });
    const data = unwrap(body);
    const rec = Array.isArray(data) ? data.find(isObj) : isObj(data) ? data : undefined;
    if (!rec) return ok('No company found for these details.', { found: false });
    const company: Record<string, unknown> = stripUndefined({
      found: true,
      ...normalizeCompanyLookup(rec),
      raw: stripHeavy(rec),
    });
    const warn = args.eik && !isValidEik(args.eik) ? ' (warning: the EIK checksum does not validate)' : '';
    return ok(
      `Found: ${company.name ?? 'unnamed company'}${company.eik ? `, ЕИК ${company.eik}` : ''}${warn}`,
      company,
    );
  },
});

export const listCompanies = defineTool({
  name: 'nula_list_companies',
  toolset: 'core',
  title: 'List configured companies',
  description:
    'List the nula.bg companies (profiles) configured in this MCP server. Pass the alias as `company` to other ' +
    'tools to act on that company. API keys are never shown.',
  kind: 'read',
  input: z.object({}),
  async run(_args, { env }) {
    const aliases = Object.keys(env.config.profiles);
    return ok(`${aliases.length} companies configured; default: ${env.config.defaultProfile}.`, {
      companies: aliases.map((alias) => ({ alias, is_default: alias === env.config.defaultProfile })),
    });
  },
});
