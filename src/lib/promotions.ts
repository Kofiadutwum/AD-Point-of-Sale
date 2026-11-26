import { divHalfUp } from './decimal';

// Spec 6.29. Pure, shared by the till and the server so both compute the same automatic discounts. Whole pesewas, half up.

export type PromoKind = 'percent_off' | 'amount_off' | 'buy_x_get_y' | 'multi_buy' | 'cart_percent' | 'cart_amount';
export type Promo = {
  id: string; name: string; kind: PromoKind; productIds: string[]; categoryIds: string[];
  percentBp: number | null; amountPesewas: number | null; buyQty: number | null; getQty: number | null; groupQty: number | null; groupPricePesewas: number | null;
  minSubtotalPesewas: number; startsOn: string | null; endsOn: string | null; days: number[]; startTime: string | null; endTime: string | null;
  branchIds: string[]; stackable: boolean; requiresCoupon: boolean; createdAt: string;
};
export type PromoLine = { productId: string; categoryId: string | null; unitPricePesewas: number; quantity: string; grossPesewas: number; manualDiscountPesewas: number };

/** Running now at this branch: date range, day of week, time window (local time 'HH:MM'). */
export function promoRunning(p: Promo, at: { date: string; weekday: number; time: string; branchId: string }): boolean {
  if (p.startsOn && at.date < p.startsOn) return false;
  if (p.endsOn && at.date > p.endsOn) return false;
  if (p.days.length && !p.days.includes(at.weekday)) return false;
  if (p.startTime && at.time < p.startTime) return false;
  if (p.endTime && at.time >= p.endTime) return false;
  return !p.branchIds.length || p.branchIds.includes(at.branchId);
}

const matches = (p: Promo, l: PromoLine) => (!p.productIds.length && !p.categoryIds.length) || p.productIds.includes(l.productId) || (l.categoryId !== null && p.categoryIds.includes(l.categoryId));
const pct = (amount: number, bp: number) => Number(divHalfUp(BigInt(amount) * BigInt(bp), 10000n));
const wholeUnits = (q: string) => Math.floor(Number(q) + 1e-9);

/**
 * The automatic discount for each line (pesewas), never more than what is left after the manual discount.
 * Per line: the best non-stackable line promotion (tie: oldest) plus every stackable one; then group promotions
 * (buy X get Y, N for a price) on lines without a non-stackable promotion; then the best cart promotion if the cart still qualifies.
 */
export function applyPromotions(lines: PromoLine[], promos: Promo[]): { discounts: number[]; applied: string[] } {
  const left = lines.map((l) => Math.max(0, l.grossPesewas - l.manualDiscountPesewas));
  const discounts = lines.map(() => 0);
  const applied = new Set<string>();
  const give = (i: number, amount: number, id: string) => {
    const d = Math.min(amount, left[i]);
    if (d <= 0) return;
    discounts[i] += d;
    left[i] -= d;
    applied.add(id);
  };
  const oldestFirst = [...promos].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lineValue = (p: Promo, l: PromoLine) => (p.kind === 'percent_off' ? pct(l.grossPesewas, p.percentBp ?? 0) : p.kind === 'amount_off' ? Math.round((p.amountPesewas ?? 0) * Number(l.quantity)) : 0);
  const claimed = lines.map(() => false);

  lines.forEach((l, i) => {
    const options = oldestFirst.filter((p) => (p.kind === 'percent_off' || p.kind === 'amount_off') && matches(p, l));
    let best: Promo | null = null;
    for (const p of options.filter((x) => !x.stackable)) if (!best || lineValue(p, l) > lineValue(best, l)) best = p;
    if (best && lineValue(best, l) > 0) { give(i, lineValue(best, l), best.id); claimed[i] = true; }
    for (const p of options.filter((x) => x.stackable)) give(i, lineValue(p, l), p.id);
  });

  for (const p of oldestFirst.filter((x) => x.kind === 'buy_x_get_y' || x.kind === 'multi_buy')) {
    const idx = lines.map((_, i) => i).filter((i) => matches(p, lines[i]) && (p.stackable || !claimed[i]));
    const units = idx.flatMap((i) => Array.from({ length: wholeUnits(lines[i].quantity) }, () => ({ i, price: lines[i].unitPricePesewas })));
    if (p.kind === 'buy_x_get_y') {
      const size = (p.buyQty ?? 1) + (p.getQty ?? 1);
      const free = Math.floor(units.length / size) * (p.getQty ?? 1);
      units.sort((a, b) => a.price - b.price).slice(0, free).forEach((u) => give(u.i, pct(u.price, p.percentBp ?? 10000), p.id)); // the cheapest units are the discounted ones
    } else {
      const n = p.groupQty ?? 2;
      units.sort((a, b) => b.price - a.price);
      for (let g = 0; g + n <= units.length; g += n) {
        const group = units.slice(g, g + n);
        let off = group.reduce((s, u) => s + u.price, 0) - (p.groupPricePesewas ?? 0);
        for (const u of [...group].sort((a, b) => a.price - b.price)) { // taken from the cheapest units first
          if (off <= 0) break;
          const d = Math.min(off, u.price);
          give(u.i, d, p.id);
          off -= d;
        }
      }
    }
    if (!p.stackable) idx.forEach((i) => { claimed[i] = true; });
  }

  const net = left.reduce((s, v) => s + v, 0);
  const cartValue = (p: Promo) => (net < p.minSubtotalPesewas ? 0 : p.kind === 'cart_percent' ? pct(net, p.percentBp ?? 0) : Math.min(p.amountPesewas ?? 0, net));
  const carts = oldestFirst.filter((p) => p.kind === 'cart_percent' || p.kind === 'cart_amount');
  let bestCart: Promo | null = null;
  for (const p of carts.filter((x) => !x.stackable)) if (!bestCart || cartValue(p) > cartValue(bestCart)) bestCart = p;
  for (const p of [...(bestCart ? [bestCart] : []), ...carts.filter((x) => x.stackable)]) {
    const total = cartValue(p);
    const base = left.reduce((s, v) => s + v, 0);
    if (total <= 0 || base <= 0) continue;
    // spread in proportion to what is left on each line; leftover pesewas go to the largest line
    const shares = left.map((v) => Math.floor((total * v) / base));
    shares[left.indexOf(Math.max(...left))] += total - shares.reduce((s, v) => s + v, 0);
    shares.forEach((d, i) => give(i, d, p.id));
  }
  return { discounts, applied: [...applied] };
}
