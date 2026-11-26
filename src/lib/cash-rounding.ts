/** Steps a shop may round cash to, in pesewas; 0 = off (spec 6.40). */
export const CASH_ROUNDING_STEPS = [0, 5, 10, 50, 100] as const;

/**
 * Spec 6.40: what cash pays (the total less non-cash tenders) rounded half up to the step; returns the difference to add to the amount due.
 * 0 without a cash tender or when the step is 0. Shared by the server and the till so both agree on change.
 */
export function cashRounding(totalPesewas: number, nonCashPesewas: number, hasCash: boolean, step: number): number {
  if (!hasCash || step <= 0) return 0;
  const cash = Math.max(0, totalPesewas - nonCashPesewas);
  return Math.floor((2 * cash + step) / (2 * step)) * step - cash;
}
