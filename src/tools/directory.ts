/** Customers, inventory and banking: read-only lookups. */
import { z } from 'zod';
import { resolveRange } from '../mappers/dates.ts';
import { formatMoney } from '../mappers/money.ts';
import { NulaApiError, type Query } from '../nula/client.ts';
import {
  extractList,
  htmlToText,
  isObj,
  normalizeBankAccount,
  normalizeCustomer,
  normalizeTransaction,
  type Obj,
  pickBool,
  pickNum,
  pickStr,
  stripUndefined,
  unwrap,
} from '../nula/normalize.ts';
import { applyLimit, defineTool, fitItems, ok, type ToolCall } from './define.ts';
import { idParam, isoDate, page, responseFormat } from './schemas.ts';

// ---------------------------------------------------------------- customers

export const searchCustomers = defineTool({
  name: 'nula_search_customers',
  toolset: 'customers',
  title: 'Search customers',
  description:
    'Find customers/counterparties (клиенти, контрагенти) by name, EIK or VAT number, or get one by id. ' +
    'nula.bg has no API to create customers directly: nula_create_invoice creates a missing customer automatically.',
  kind: 'read',
  input: z.object({
    customer_id: idParam('customer').optional(),
    search: z.string().min(1).optional().describe('Name, EIK or VAT number'),
    page,
    limit: z.number().int().min(1).max(100).optional().describe('Max records to return from the page (default 25)'),
    response_format: responseFormat,
  }),
  async run(args, { client, ctx }) {
    const signal = ctx.mcpReq.signal;
    if (args.customer_id) {
      const data = unwrap(await client.get(`/api/v1/customers/${args.customer_id}`, { signal }));
      const customer = normalizeCustomer(isObj(data) ? data : {}, true);
      return ok(`${customer.name ?? 'Customer'}${customer.eik ? `, ЕИК ${customer.eik}` : ''}`, customer);
    }
    const body = await client.get('/api/v1/customers', { query: { search: args.search, page: args.page }, signal });
    const { items, page: pg } = extractList(body, args.page ?? 1);
    const { items: customers, note } = applyLimit(
      items.map((c) => normalizeCustomer(c, args.response_format === 'detailed')),
      args.limit,
    );
    return ok(
      `${customers.length} customers${pg.has_more ? ' (more pages available)' : ''}.${note ? ` ${note}` : ''}`,
      fitItems({ items: customers, ...pg, note }, 'Use a more specific search.'),
    );
  },
});

// ---------------------------------------------------------------- inventory

function normalizeProduct(p: Obj, detailed: boolean): Obj {
  const tr = isObj(p.translations) ? p.translations : {};
  const bg = isObj(tr.bg) ? tr.bg : {};
  const en = isObj(tr['en-gb']) ? tr['en-gb'] : {};
  const prices = isObj(p.prices) ? p.prices : {};
  return stripUndefined({
    id: pickNum(p, 'product_id', 'id'),
    sku: pickStr(p, 'sku'),
    model: pickStr(p, 'model'),
    name: pickStr(bg, 'name') ?? pickStr(p, 'name'),
    name_en: pickStr(en, 'name', 'english_name'),
    unit: pickStr(p, 'unit'),
    quantity: pickNum(p, 'quantity'),
    in_stock: typeof p.stock_status === 'string' ? p.stock_status === 'in_stock' : undefined,
    track_quantity: pickBool(p, 'track_quantity'),
    active: pickBool(p, 'status'),
    sale_price: pickNum(prices, 'sale_price') ?? pickNum(p, 'sale_price'),
    purchase_price: pickNum(prices, 'purchase_price') ?? pickNum(p, 'purchase_price'),
    category_ids: Array.isArray(p.categories) ? p.categories : undefined,
    description: detailed ? htmlToText(pickStr(bg, 'description')) : undefined,
    description_en: detailed ? htmlToText(pickStr(en, 'description')) : undefined,
  });
}

function normalizeItemDetails(d: Obj): Obj {
  return stripUndefined({
    name: pickStr(d, 'name'),
    sku: pickStr(d, 'sku'),
    name_en: pickStr(d, 'english_name'),
    purchase_account: pickStr(d, 'purchase_account'),
    purchase_price: pickNum(d, 'purchase_price'),
    sale_account: pickStr(d, 'sale_account'),
    sale_price: pickNum(d, 'sale_price'),
    track_quantity: pickBool(d, 'is_tracked'),
    quantity: pickNum(d, 'available_quantity'),
  });
}

/**
 * Verified 2026-09-26: `/open-cart/products/{sku}` and `getItemDetails` answer 404 even for products that
 * exist, and the `search` filter does not match SKU or model — only `name` does. So SKU lookups scan the
 * catalogue pages locally.
 */
async function fetchProductPage(client: ToolCall['client'], query: Query, signal?: AbortSignal) {
  const body = await client.get('/api/v1/open-cart/products', { query, signal });
  const data = unwrap(body);
  const list = isObj(data) && Array.isArray(data.products) ? data.products.filter(isObj) : extractList(body).items;
  const meta = isObj(data) && isObj(data.meta) ? data.meta : {};
  return { list, meta };
}

async function findBySku(client: ToolCall['client'], sku: string, signal?: AbortSignal): Promise<Obj | undefined> {
  const direct = await client
    .get(`/api/v1/open-cart/products/${encodeURIComponent(sku)}`, { signal })
    .then((b) => unwrap(b))
    .catch((e) => (e instanceof NulaApiError && e.status === 404 ? undefined : Promise.reject(e)));
  const product = isObj(direct) && isObj(direct.product) ? direct.product : isObj(direct) ? direct : undefined;
  if (product) return product;

  const wanted = sku.trim().toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { list, meta } = await fetchProductPage(client, { per_page: 100, page }, signal);
    const hit = list.find((p) =>
      [pickStr(p, 'sku'), pickStr(p, 'model'), pickStr(p, 'barcode')].some((v) => v?.trim().toLowerCase() === wanted),
    );
    if (hit) return hit;
    const last = pickNum(meta, 'last_page');
    if (list.length === 0 || (last !== undefined && page >= last)) break;
  }
  return undefined;
}

export const searchItems = defineTool({
  name: 'nula_search_items',
  toolset: 'inventory',
  title: 'Search items and stock',
  description:
    'Find products/services (артикули) with prices and available stock (наличност). Give sku for an exact match, ' +
    'or query/name to match the name. Use it before invoicing to reuse the correct item name, sku and price.',
  kind: 'read',
  input: z.object({
    sku: z.string().min(1).optional().describe('Exact SKU (Арт. номер), model or barcode'),
    query: z.string().min(1).optional().describe('Text to match in the item name'),
    name: z.string().min(1).optional().describe('Same as query (matches the name)'),
    page,
    per_page: z.number().int().min(1).max(100).optional().describe('Default 25'),
    response_format: responseFormat,
  }),
  async run(args, { client, ctx }) {
    const signal = ctx.mcpReq.signal;
    const detailed = args.response_format === 'detailed';

    if (args.sku) {
      const product = await findBySku(client, args.sku, signal);
      if (!product) return ok(`No item with SKU/model/barcode "${args.sku}".`, { items: [] });
      // getItemDetails adds ledger accounts and tracked stock when the company has them; it may 404.
      const details = await client
        .get('/api/v1/getItemDetails', { query: { sku: args.sku }, signal })
        .then((b) => unwrap(b))
        .catch(() => undefined);
      const item = stripUndefined({
        ...(isObj(details) ? normalizeItemDetails(details) : {}),
        ...normalizeProduct(product, true),
      });
      return ok(
        `${item.name ?? args.sku}: ${item.quantity ?? '?'} ${item.unit ?? ''} in stock, sale price ${formatMoney(item.sale_price as number | undefined)}.`,
        { items: [item] },
      );
    }

    const text = args.query ?? args.name;
    const { list, meta } = await fetchProductPage(
      client,
      { name: text, page: args.page, per_page: args.per_page ?? 25 },
      signal,
    );
    const items = list.map((p) => normalizeProduct(p, detailed));
    const pg = stripUndefined({
      page: pickNum(meta, 'current_page') ?? args.page ?? 1,
      total: pickNum(meta, 'total'),
      last_page: pickNum(meta, 'last_page'),
    });
    const hasMore = pg.last_page !== undefined ? pg.page < pg.last_page : undefined;
    return ok(
      `${items.length} items${pg.total !== undefined ? ` of ${pg.total}` : ''}.`,
      fitItems({ items, ...pg, has_more: hasMore }, 'Use a narrower query.'),
    );
  },
});

export const listItemCategories = defineTool({
  name: 'nula_list_item_categories',
  toolset: 'inventory',
  title: 'List item categories',
  description: 'List item categories (категории на артикули) that have at least one item.',
  kind: 'read',
  input: z.object({ page, per_page: z.number().int().min(1).max(100).optional() }),
  async run(args, { client, ctx }) {
    const body = await client.get('/api/v1/open-cart/categories', {
      query: { page: args.page, per_page: args.per_page ?? 100 },
      signal: ctx.mcpReq.signal,
    });
    const data = unwrap(body);
    const list =
      isObj(data) && Array.isArray(data.categories) ? data.categories.filter(isObj) : extractList(body).items;
    const items = list.map((c) => {
      const tr = isObj(c.translations) ? c.translations : {};
      return stripUndefined({
        id: pickNum(c, 'category_id', 'id'),
        parent_id: pickNum(c, 'parent_id') || undefined,
        name: pickStr(isObj(tr.bg) ? tr.bg : {}, 'name') ?? pickStr(c, 'name'),
        name_en: pickStr(isObj(tr['en-gb']) ? tr['en-gb'] : {}, 'name'),
      });
    });
    return ok(`${items.length} categories.`, { items });
  },
});

// ---------------------------------------------------------------- banking

export const listBankAccounts = defineTool({
  name: 'nula_list_bank_accounts',
  toolset: 'banking',
  title: 'List bank accounts',
  description:
    'List the bank accounts (банкови сметки) connected in nula.bg, with their ids for nula_list_bank_transactions.',
  kind: 'read',
  input: z.object({
    all_companies: z.boolean().optional().describe("Include accounts of all the user's companies, not only this one"),
  }),
  async run(args, { client, ctx }) {
    const body = await client.get('/api/v1/getBanks', {
      query: { allBanks: args.all_companies ? 1 : 0 },
      signal: ctx.mcpReq.signal,
    });
    const items = extractList(body).items.map(normalizeBankAccount);
    const lines = items.map((a) =>
      `${a.id}: ${a.name ?? ''} ${a.iban ?? ''} ${a.balance !== undefined ? formatMoney(a.balance as number, (a.currency as string) ?? 'EUR') : ''}`.trim(),
    );
    return ok([`${items.length} bank accounts.`, ...lines].join('\n'), { items });
  },
});

export const listBankTransactions = defineTool({
  name: 'nula_list_bank_transactions',
  toolset: 'banking',
  title: 'List bank transactions',
  description:
    'List bank transactions (банкови движения) of one account for a period. Get account ids from nula_list_bank_accounts.',
  kind: 'read',
  input: z.object({
    bank_account_id: idParam('bank account'),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    page,
    limit: z.number().int().min(1).max(100).optional().describe('Max records to return from the page (default 25)'),
  }),
  async run(args, { client, ctx }) {
    const range = resolveRange(args.date_from, args.date_to);
    const body = await client.get(`/api/v1/transactions/${args.bank_account_id}/getTransactions`, {
      query: { from: range?.from, to: range?.to, page: args.page },
      signal: ctx.mcpReq.signal,
    });
    const { items, page: pg } = extractList(body, args.page ?? 1);
    const { items: txs, note } = applyLimit(items.map(normalizeTransaction), args.limit);
    const sum = (dir: string) =>
      txs.filter((t) => t.direction === dir).reduce((s, t) => s + ((t.amount as number) ?? 0), 0);
    return ok(
      `${txs.length} transactions${range ? ` ${range.from}…${range.to}` : ''}: in ${formatMoney(sum('in'))}, out ${formatMoney(sum('out'))} (this page).`,
      fitItems({ items: txs, ...pg, note }, 'Narrow the period.'),
    );
  },
});
