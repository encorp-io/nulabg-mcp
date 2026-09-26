/** Bulgarian EIK/BULSTAT, EU VAT numbers, IBAN and document numbers. */

export const EIK_PATTERN = /^(\d{9}|\d{13})$/;
export const VAT_PATTERN = /^[A-Z]{2}[0-9A-Z+*]{2,13}$/;
export const DOC_NUMBER_PATTERN = /^\d{1,10}$/;

/** nula.bg's placeholder for a foreign counterparty without a VAT number. */
export const NO_VAT_NUMBER = '999999999999999';

function weighted(digits: number[], weights: number[]): number {
  return weights.reduce((sum, w, i) => sum + w * (digits[i] ?? 0), 0) % 11;
}

/** Validates the check digit(s) of a 9- or 13-digit EIK (ЕИК/БУЛСТАТ). */
export function isValidEik(eik: string): boolean {
  if (!EIK_PATTERN.test(eik)) return false;
  const d = [...eik].map(Number);
  let c9 = weighted(d, [1, 2, 3, 4, 5, 6, 7, 8]);
  if (c9 === 10) c9 = weighted(d, [3, 4, 5, 6, 7, 8, 9, 10]);
  if (c9 === 10) c9 = 0;
  if (c9 !== d[8]) return false;
  if (eik.length === 9) return true;

  const tail = [d[8]!, d[9]!, d[10]!, d[11]!];
  let c13 = weighted(tail, [2, 7, 3, 5]);
  if (c13 === 10) c13 = weighted(tail, [4, 9, 5, 7]);
  if (c13 === 10) c13 = 0;
  return c13 === d[12];
}

export function normalizeVat(vat: string): string {
  return vat.replace(/[\s.-]/g, '').toUpperCase();
}

export function isBulgarianVat(vat: string): boolean {
  return normalizeVat(vat).startsWith('BG');
}

/** Pads a document number to nula.bg's 10-digit format: `124` → `0000000124`. */
export function padDocNumber(n: string | number): string {
  const s = String(n).trim();
  if (!DOC_NUMBER_PATTERN.test(s)) throw new Error(`Invalid document number "${s}" (up to 10 digits)`);
  return s.padStart(10, '0');
}

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/** ISO 13616 mod-97 check. */
export function isValidIban(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
