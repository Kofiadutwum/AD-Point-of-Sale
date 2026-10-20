// Rates are basis points (1500 = 15%), entered by each shop; none are hard-coded (spec 4.11).

export type Levy = { name: string; rateBp: number };
export type TaxRates = { rateBp: number; levies: Levy[]; vatOnLevies: boolean };

/** One rate for the till (spec 6.6). With VAT on levies, the main rate is charged on the price plus the levies. */
export function effectiveRateBp({ rateBp, levies, vatOnLevies }: TaxRates): number {
  const levySum = levies.reduce((sum, l) => sum + l.rateBp, 0);
  return levySum + (vatOnLevies ? Math.round((rateBp * (10000 + levySum)) / 10000) : rateBp);
}

/** '2.5' → 250. Null unless 0–100 with up to 2 decimals. */
export function parsePercent(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10000 ? bp : null;
}

/** No tax when the shop switched it off; else the product's own rule; else the shop default. */
export function chooseTaxRule<R extends { id: string; isDefault: boolean }>(
  taxEnabled: boolean, productTaxRuleId: string | null, rules: R[],
): R | null {
  if (!taxEnabled) return null;
  return (productTaxRuleId ? rules.find((r) => r.id === productTaxRuleId) : rules.find((r) => r.isDefault)) ?? null;
}
