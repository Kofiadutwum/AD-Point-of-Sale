/** Where the item code and value sit in a shop's scale labels; positions are 0-based digit indexes (spec 4.16). */
export type ScaleLayout = {
  prefix: string; itemStart: number; itemLength: number; valueStart: number; valueLength: number; carries: 'weight' | 'price';
};

const PRINTABLE = /^[\x21-\x7E]{1,64}$/;

/** Trimmed, printable, no spaces. UPC-A is EAN-13 with a leading zero and scanners send either form. */
export function normaliseBarcode(input: string): string | null {
  const code = input.trim();
  if (!PRINTABLE.test(code)) return null;
  return /^\d{12}$/.test(code) ? `0${code}` : code;
}

export function ean13CheckDigit(first12: string): string {
  const sum = [...first12].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

export function ean13Valid(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === code[12];
}

export function validScaleLayout(layout: ScaleLayout): boolean {
  const { prefix, itemStart, itemLength, valueStart, valueLength, carries } = layout;
  if (typeof prefix !== 'string' || !/^2\d?$/.test(prefix) || (carries !== 'weight' && carries !== 'price')) return false;
  const fits = (start: number, length: number) => Number.isInteger(start) && Number.isInteger(length)
    && length >= 1 && length <= 6 && start >= prefix.length && start + length <= 12; // index 12 is the check digit
  const apart = itemStart + itemLength <= valueStart || valueStart + valueLength <= itemStart;
  return fits(itemStart, itemLength) && fits(valueStart, valueLength) && apart;
}

export function matchesScaleLayout(code: string, layout: ScaleLayout | null): boolean {
  return layout !== null && /^\d{13}$/.test(code) && code.startsWith(layout.prefix);
}

/** Null when the code is not a scale label of this layout; the label's item code and value otherwise (spec 6.22). */
export function readScaleLabel(code: string, layout: ScaleLayout | null): { itemCode: number; value: number } | 'bad_check_digit' | null {
  if (!layout || !matchesScaleLayout(code, layout)) return null;
  if (!ean13Valid(code)) return 'bad_check_digit';
  const digits = (start: number, length: number) => Number(code.slice(start, start + length));
  return { itemCode: digits(layout.itemStart, layout.itemLength), value: digits(layout.valueStart, layout.valueLength) };
}
