// Quantities are canonical strings with exactly 3 decimal places ('1.250'); unit costs have 4 ('416.6667').
// Arithmetic runs on non-negative BigInt scaled integers, never on floats.

const QUANTITY = /^(\d{1,11})(?:\.(\d{1,3}))?$/; // numeric(14,3)

function scaled(value: string, places: number): bigint {
  const [whole, frac = ''] = value.split('.');
  if (frac.length > places) throw new Error(`more than ${places} decimal places: ${value}`);
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, '0'));
}

function unscaled(n: bigint, places: number): string {
  const unit = 10n ** BigInt(places);
  return `${n / unit}.${(n % unit).toString().padStart(places, '0')}`;
}

/** n / d rounded half up, for n ≥ 0 and d > 0. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/** '1.25' → '1.250'. Null unless a plain non-negative number with up to 3 decimals and 11 whole digits. */
export function parseQuantity(input: string): string | null {
  const m = QUANTITY.exec(input.trim());
  return m ? fromMilli(BigInt(m[1]) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'))) : null;
}

export function toMilli(q: string): bigint {
  return scaled(q, 3);
}

export function fromMilli(m: bigint): string {
  return unscaled(m, 3);
}

export function isWhole(q: string): boolean {
  return toMilli(q) % 1000n === 0n;
}

/** Above zero, and whole unless the unit allows fractions (spec 6.0). */
export function validSaleQuantity(q: string | null, allowsFractions: boolean): boolean {
  return q !== null && toMilli(q) > 0n && (allowsFractions || isWhole(q));
}

/** a × b to 3 places, half up: base_qty = quantity × unit.factor. */
export function multiplyQty(a: string, b: string): string {
  return fromMilli(divHalfUp(toMilli(a) * toMilli(b), 1000n));
}

/** n / d to 3 places, half up. */
export function ratioToQty(n: bigint, d: bigint): string {
  return fromMilli(divHalfUp(n * 1000n, d));
}

/** Σ quantity × unit cost, to 4 places, half up: the cost of a bundle or recipe. */
export function rollUpCost(parts: Array<{ quantity: string; cost: string }>): string {
  const total = parts.reduce((sum, p) => sum + toMilli(p.quantity) * scaled(p.cost, 4), 0n);
  return unscaled(divHalfUp(total, 1000n), 4);
}
