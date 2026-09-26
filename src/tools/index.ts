import type { McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { FileInputError } from '../files.ts';
import { describeError } from '../nula/errors.ts';
import { createBill, searchBills, updateBillCategories } from './bills.ts';
import { listCompanies, lookupCompany } from './core.ts';
import { fail, type ToolEnv, type ToolResult, type ToolSpec } from './define.ts';
import {
  listBankAccounts,
  listBankTransactions,
  listItemCategories,
  searchCustomers,
  searchItems,
} from './directory.ts';
import { noiDocuments, noiGetDocument, nraDeclarations, nraRefreshResult } from './filings.ts';
import { matchBankTransactions, periodSummary, receivablesReport } from './insights.ts';
import {
  createInvoice,
  deleteLastInvoice,
  emailInvoice,
  getInvoicePdf,
  searchInvoices,
  updateInvoice,
  updateInvoiceMetadata,
} from './invoices.ts';
import { ocrStatus, ocrUpload } from './ocr.ts';

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry of tool specs
export const ALL_TOOLS: ToolSpec<any>[] = [
  lookupCompany,
  listCompanies,
  searchInvoices,
  createInvoice,
  updateInvoice,
  updateInvoiceMetadata,
  getInvoicePdf,
  emailInvoice,
  deleteLastInvoice,
  searchBills,
  createBill,
  updateBillCategories,
  ocrUpload,
  ocrStatus,
  searchCustomers,
  searchItems,
  listItemCategories,
  listBankAccounts,
  listBankTransactions,
  receivablesReport,
  periodSummary,
  matchBankTransactions,
  nraDeclarations,
  nraRefreshResult,
  noiDocuments,
  noiGetDocument,
];

/** Tools enabled by the configuration: toolsets, read-only mode, and multi-company profiles. */
export function selectTools(config: Config): ToolSpec[] {
  const multi = Object.keys(config.profiles).length > 1;
  return ALL_TOOLS.filter(
    (t) =>
      config.toolsets.has(t.toolset) &&
      (!config.readOnly || t.kind === 'read') &&
      (t.name !== listCompanies.name || multi),
  );
}

export function annotationsFor(tool: ToolSpec): ToolAnnotations {
  if (tool.kind === 'read') {
    return { title: tool.title, readOnlyHint: true, openWorldHint: tool.annotations?.openWorldHint ?? false };
  }
  return {
    title: tool.title,
    readOnlyHint: false,
    destructiveHint: tool.annotations?.destructiveHint ?? false,
    idempotentHint: tool.annotations?.idempotentHint ?? false,
    openWorldHint: tool.annotations?.openWorldHint ?? false,
  };
}

export function registerTools(server: McpServer, env: ToolEnv, tools: ToolSpec[]): void {
  const aliases = Object.keys(env.config.profiles);
  const multi = aliases.length > 1;

  for (const tool of tools) {
    const input =
      multi && tool.name !== listCompanies.name
        ? tool.input.extend({
            company: z
              .enum(aliases as [string, ...string[]])
              .optional()
              .describe(`Company profile to use (default "${env.config.defaultProfile}"). See nula_list_companies.`),
          })
        : tool.input;

    const handler = async (args: Record<string, unknown>, ctx: ServerContext): Promise<ToolResult> => {
      const { company, ...rest } = args as { company?: string } & Record<string, unknown>;
      const alias = company ?? env.config.defaultProfile!;
      const started = Date.now();
      try {
        const result = await tool.run(rest, { client: env.clientFor(alias), ctx, env, company: alias });
        env.logger.debug(`${tool.name} done in ${Date.now() - started}ms`);
        return result;
      } catch (err) {
        if (err instanceof FileInputError) return fail(err.message);
        env.logger.warn(`${tool.name} failed`, { error: (err as Error).message });
        return fail(describeError(err, tool.fieldMap));
      }
    };

    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: input, annotations: annotationsFor(tool) },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK infers args from the schema; our handler is generic
      handler as any,
    );
  }
}
