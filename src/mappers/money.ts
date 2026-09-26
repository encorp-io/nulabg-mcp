/** Rounds half away from zero to 2 decimals without binary floating-point surprises (1.005 → 1.01). */
export function round2(n: number): number {
  return (Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

export function hasAtMostTwoDecimals(n: number): boolean {
  return Math.abs(round2(n) - n) < 1e-9;
}

const SYMBOLS: Record<string, string> = { EUR: '€', BGN: 'лв.', USD: '$', GBP: '£' };

/** Bulgarian formatting for text summaries: `1234.5, "EUR"` → `1 234,50 €`. */
export function formatMoney(amount: number | undefined, currency = 'EUR'): string {
  if (amount === undefined || !Number.isFinite(amount)) return '—';
  const n = new Intl.NumberFormat('bg-BG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: 'always',
  })
    .format(amount)
    .replace(/ | /g, ' ');
  return `${n} ${SYMBOLS[currency] ?? currency}`;
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
