/** Date helpers. MCP tools speak ISO `YYYY-MM-DD`; nula.bg uses several formats. */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BG_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Today's date in Bulgaria (Europe/Sofia), so an invoice issued at 01:30 local time is not dated yesterday. */
export function todaySofia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `2026-09-22` → `22.09.2026` (createInvoice / createBill / editInvoice). */
export function isoToBg(iso: string): string {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new Error(`Invalid date "${iso}", expected YYYY-MM-DD`);
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** `YYYY-MM-DD_YYYY-MM-DD` for the `daterange` filter of getInvoices / bills. */
export function toDateRange(from: string, to: string): string {
  return `${from}_${to}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Resolves an optional date range: a missing end is today, a missing start is 1 January of the end's year. */
export function resolveRange(from: string | undefined, to: string | undefined, today = todaySofia()) {
  if (!from && !to) return undefined;
  const end = to ?? today;
  const start = from ?? `${end.slice(0, 4)}-01-01`;
  return { from: start, to: end };
}

/**
 * Best-effort normalisation of whatever date nula.bg returns
 * (`22.09.2026`, `2026-09-22`, `2026-09-22 10:00:00`, `2026-09-22T10:00:00.000000Z`) to `YYYY-MM-DD`.
 */
export function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const v = value.trim();
  const bg = BG_DATE.exec(v);
  if (bg) return `${bg[3]}-${bg[2]!.padStart(2, '0')}-${bg[1]!.padStart(2, '0')}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (iso) {
    // A UTC timestamp near midnight belongs to the next day in Sofia.
    if (/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
      const t = new Date(v);
      if (!Number.isNaN(t.getTime())) return todaySofia(t);
    }
    return iso[1];
  }
  return undefined;
}
