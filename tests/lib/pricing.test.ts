import { expect, it } from 'vitest';
import { choosePriceList, type PriceRule, resolvePrice } from '@/lib/pricing';

const list = (o: Partial<PriceRule> & Pick<PriceRule, 'id' | 'kind'>): PriceRule =>
  ({ branchId: null, startsOn: null, endsOn: null, active: true, items: [], ...o });
const sell = (o: Partial<Parameters<typeof resolvePrice>[1]> = {}) =>
  ({ unitId: 'u', quantity: '1.000', unitPricePesewas: null, unitFactor: '1.000', basePricePesewas: 500, ...o });
const retail = list({ id: 'retail', kind: 'retail', items: [
  { unitId: 'u', minQuantity: '1.000', pricePesewas: 500 }, { unitId: 'u', minQuantity: '12.000', pricePesewas: 450 },
] });
const pick = (lists: PriceRule[], o: Partial<Parameters<typeof choosePriceList>[1]> = {}) =>
  choosePriceList(lists, { cartListId: null, customerListId: null, branchId: 'b1', today: '2026-10-20', ...o })?.id ?? null;

it('applies the quantity break at and above its minimum', () => {
  expect(resolvePrice(retail, sell({ quantity: '11.000' }))).toBe(500);
  expect(resolvePrice(retail, sell({ quantity: '12.000' }))).toBe(450);
  expect(resolvePrice(retail, sell({ quantity: '30.000' }))).toBe(450);
});

it('falls back to the unit price, then base price × factor', () => {
  expect(resolvePrice(null, sell({ unitId: 'carton', unitPricePesewas: 10000, unitFactor: '24.000' }))).toBe(10000);
  expect(resolvePrice(retail, sell({ unitId: 'carton', unitFactor: '24.000' }))).toBe(12000);
});

it('chooses the cart list, then the customer list, then the branch list, then Retail', () => {
  const lists = [retail, list({ id: 'cart', kind: 'wholesale' }), list({ id: 'customer', kind: 'customer_group' }),
    list({ id: 'branch', kind: 'branch', branchId: 'b1' })];
  expect(pick(lists, { cartListId: 'cart', customerListId: 'customer' })).toBe('cart');
  expect(pick(lists, { customerListId: 'customer' })).toBe('customer');
  expect(pick(lists)).toBe('branch');
  expect(pick([retail])).toBe('retail');
  expect(pick([])).toBeNull();
});

it('skips lists that are inactive, not started, or ended', () => {
  const xmas = list({ id: 'xmas', kind: 'branch', branchId: 'b1', startsOn: '2026-12-01', endsOn: '2026-12-31' });
  expect(pick([retail, xmas], { today: '2026-11-30' })).toBe('retail');
  expect(pick([retail, xmas], { today: '2026-12-01' })).toBe('xmas');
  expect(pick([retail, xmas], { today: '2026-12-31' })).toBe('xmas');
  expect(pick([retail, xmas], { today: '2027-01-01' })).toBe('retail');
  expect(pick([retail, { ...xmas, active: false }], { today: '2026-12-10' })).toBe('retail');
  expect(pick([retail, list({ id: 'promo', kind: 'wholesale', endsOn: '2026-10-19' })], { cartListId: 'promo' })).toBe('retail');
});

it("ignores another branch's list", () => {
  const other = list({ id: 'b2-list', kind: 'branch', branchId: 'b2' });
  expect(pick([retail, other])).toBe('retail');
  expect(pick([retail, other], { cartListId: 'b2-list' })).toBe('retail');
});
