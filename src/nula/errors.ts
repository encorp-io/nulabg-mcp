import { NulaApiError } from './client.ts';
import { isObj } from './normalize.ts';

/** Maps nula.bg field names back to MCP parameter names in validation messages. */
export type FieldMap = Record<string, string>;

/** `items.0.price` → `lines[0].unit_price` using entries like `'items[].price': 'lines[].unit_price'`. */
export function mapFieldName(field: string, fieldMap: FieldMap): string {
  const dotted = field.replace(/\.(\d+)(?=\.|$)/g, '[$1]');
  const generic = dotted.replace(/\[\d+\]/g, '[]');
  const indices = [...dotted.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
  const direct = fieldMap[dotted] ?? fieldMap[generic];
  if (direct) {
    let i = 0;
    return direct.replace(/\[\]/g, () => `[${indices[i++] ?? ''}]`);
  }
  const top = generic.split(/[.[]/)[0] ?? generic;
  const prefix = fieldMap[top];
  return prefix ? prefix.replace(/\[\]$/, '') + dotted.slice(top.length) : dotted;
}

function fieldErrors(errors: unknown, fieldMap: FieldMap): string[] {
  if (!isObj(errors)) return [];
  return Object.entries(errors).map(([field, messages]) => {
    const list = Array.isArray(messages) ? messages : [messages];
    return `- ${mapFieldName(field, fieldMap)}: ${list.map(String).join('; ')}`;
  });
}

/** Turns any error into a short, actionable message for the model. */
export function describeError(err: unknown, fieldMap: FieldMap = {}): string {
  if (!(err instanceof NulaApiError)) {
    return `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  }
  const where = `${err.method} ${err.path}`;
  const unknownOutcome = err.outcomeUnknown
    ? ' The request may or may not have been applied: verify in nula.bg (e.g. search for the document) before retrying.'
    : '';

  switch (err.kind) {
    case 'timeout':
      return `nula.bg did not respond in time (${where}).${unknownOutcome}`;
    case 'network':
      return `Cannot reach nula.bg (${where}): ${err.message.replace(/^Cannot reach nula\.bg: /, '')}.${unknownOutcome}`;
    case 'aborted':
      return 'The request was cancelled.';
    case 'invalid_response':
      return `nula.bg returned an unexpected response (${where}): ${err.message}`;
  }

  const status = err.status ?? 0;
  const detail = err.message && err.message !== 'Unauthenticated.' ? ` nula.bg says: "${err.message}".` : '';
  if (status === 401 || (status === 403 && /unauthenticated/i.test(err.message))) {
    return (
      'nula.bg rejected the API key (invalid, revoked or expired). Create a new API key in your nula.bg account ' +
      'and update NULA_API_KEY in the MCP configuration.'
    );
  }
  if (status === 402)
    return `OCR quota exhausted for this company: no scans left in the current billing cycle.${detail}`;
  if (status === 403 && /not scoped to a team/i.test(err.message)) {
    return (
      'This nula.bg API key is not scoped to a company (team) for this endpoint. The /api/native/v1 endpoints ' +
      '(OCR, НАП, НОИ) need a key created with access to the company; ask nula.bg support or create the key from ' +
      'inside the company. The /api/v1 endpoints (invoices, bills, customers, banking, inventory) work with this key.'
    );
  }
  if (status === 403 && err.path.includes('deleteInvoice')) {
    return (
      'nula.bg refused to delete the invoice (HTTP 403). This happens when the invoice is already posted to ' +
      'accounting (осчетоводена) or your role may not delete documents. Remove it in the nula.bg web app, or issue ' +
      'a credit note instead. Nothing was deleted.'
    );
  }
  if (status === 403) return `Your nula.bg plan or user role does not allow this operation (${where}).${detail}`;
  if (status === 404)
    return `Not found in this nula.bg company (${where}).${detail} Check the id/number with a search tool.`;
  if (status === 422 || status === 400) {
    const lines = fieldErrors(err.errors, fieldMap);
    return lines.length
      ? `nula.bg rejected the request:\n${lines.join('\n')}`
      : `nula.bg rejected the request (${status}).${detail || ` ${JSON.stringify(err.errors ?? err.body).slice(0, 500)}`}`;
  }
  if (status === 429) return 'nula.bg is rate-limiting requests. Wait a minute and try again.';
  if (status === 503 && err.path.includes('/nra/')) {
    return 'НАП (NRA) did not respond; the submission status was not changed. Try again later.';
  }
  if (status >= 500) return `nula.bg is temporarily unavailable (HTTP ${status}, ${where}).${unknownOutcome}`;
  return `nula.bg returned HTTP ${status} for ${where}.${detail}`;
}
