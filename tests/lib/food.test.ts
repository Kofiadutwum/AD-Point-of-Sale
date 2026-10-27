import { expect, it } from 'vitest';
import {
  checkComboChoices, type ComboSlotDef, commissionPesewas, comboUpgradeTotal, formatOrderNumber, needsPacking, offlineOrderNumber, ORDER_NUMBER, packCount, potVariance, splitComboNet,
} from '@/lib/food';

it('order numbers run 001 to 999 and wrap', () => {
  expect([1, 47, 999, 1000, 1998].map(formatOrderNumber)).toEqual(['001', '047', '999', '001', '999']);
});

it('offline numbers carry the register code', () => {
  expect(offlineOrderNumber('T2', 47)).toBe('T2-047');
  expect(ORDER_NUMBER.test('T2-047') && ORDER_NUMBER.test('047')).toBe(true);
  expect(ORDER_NUMBER.test('47') || ORDER_NUMBER.test('t2-047')).toBe(false);
});

it('counts packs per order and per item, never for eat in', () => {
  const lines = [{ variantId: 'rice', quantity: '2.000' }, { variantId: 'coke', quantity: '1.000' }, { variantId: 'pack', quantity: '1.000' }];
  const opts = { needsPack: (id: string) => id === 'rice', packVariantId: 'pack' };
  expect(packCount(lines, { ...opts, diningOption: 'takeaway', mode: 'per_order' })).toBe(1);
  expect(packCount(lines, { ...opts, diningOption: 'delivery', mode: 'per_item' })).toBe(2);
  expect(packCount(lines, { ...opts, diningOption: 'eat_in', mode: 'per_item' })).toBe(0);
  expect(packCount(lines, { ...opts, packVariantId: null, diningOption: 'takeaway', mode: 'per_order' })).toBe(0);
});

it('rounds part units up to whole packs', () => {
  expect(packCount([{ variantId: 'rice', quantity: '1.500' }], { needsPack: () => true, packVariantId: 'pack', diningOption: 'takeaway', mode: 'per_item' })).toBe(2);
});

it('a cart holding only the pack needs no pack', () => {
  expect(packCount([{ variantId: 'pack', quantity: '1.000' }], { needsPack: () => true, packVariantId: 'pack', diningOption: 'takeaway', mode: 'per_order' })).toBe(0);
});

it('only orders that leave the shop need packing', () => {
  expect([needsPacking('eat_in'), needsPacking('takeaway'), needsPacking('delivery')]).toEqual([false, true, true]);
});

const slots: ComboSlotDef[] = [{ id: 'drink', minChoices: 1, maxChoices: 1, choices: [{ variantId: 'coke', upgradePesewas: 0 }, { variantId: 'large', upgradePesewas: 500 }] }];

it('accepts a valid choice and adds upgrade prices', () => {
  expect(checkComboChoices(slots, [{ slotId: 'drink', variantId: 'large' }], new Set())).toBe('ok');
  expect(comboUpgradeTotal(slots, [{ slotId: 'drink', variantId: 'large' }])).toBe(500);
});

it('refuses too few, too many, repeated, or unknown choices', () => {
  const repeated = [{ slotId: 'drink', variantId: 'coke' }, { slotId: 'drink', variantId: 'coke' }];
  const two: ComboSlotDef[] = [{ ...slots[0], maxChoices: 2 }];
  expect(checkComboChoices(two, repeated, new Set())).toBe('invalid_choices');
  for (const chosen of [[], [{ slotId: 'drink', variantId: 'coke' }, { slotId: 'drink', variantId: 'large' }], [{ slotId: 'drink', variantId: 'fanta' }], [{ slotId: 'food', variantId: 'coke' }]]) {
    expect(checkComboChoices(slots, chosen, new Set())).toBe('invalid_choices');
  }
});

it('refuses a sold-out choice', () => {
  expect(checkComboChoices(slots, [{ slotId: 'drink', variantId: 'coke' }], new Set(['coke']))).toBe('sold_out');
});

it('works out pot variance and flags gaps above the limit', () => {
  // 3 pots cooked, 0.5 left, GHS 600 per pot -> expected 150000; actual 130000 -> variance -20000 (13.3%) -> flagged
  expect(potVariance({ cookedQty: '3.000', leftoverQty: '0.500', valuePerPotPesewas: 60000, actualPesewas: 130000, limitBp: 1000 }))
    .toEqual({ expectedPesewas: 150000, variancePesewas: -20000, flagged: true });
  expect(potVariance({ cookedQty: '3.000', leftoverQty: '0.500', valuePerPotPesewas: 60000, actualPesewas: 140000, limitBp: 1000 }).flagged).toBe(false); // 6.7%
  expect(potVariance({ cookedQty: '1.000', leftoverQty: '0.000', valuePerPotPesewas: null, actualPesewas: 5000, limitBp: 1000 }))
    .toEqual({ expectedPesewas: null, variancePesewas: null, flagged: false });
});

it('a gap of exactly the limit is not flagged', () => {
  expect(potVariance({ cookedQty: '1.000', leftoverQty: '0.000', valuePerPotPesewas: 10000, actualPesewas: 9000, limitBp: 1000 }).flagged).toBe(false);
});

it('works out commission half up', () => {
  expect(commissionPesewas(10_000, 2250)).toBe(2250);
  expect(commissionPesewas(333, 1500)).toBe(50); // 49.95 -> 50
  expect(commissionPesewas(5_000, 0)).toBe(0);
});

it('splits a combo net price in proportion and keeps every pesewa', () => {
  const s = splitComboNet(4500, [{ key: 'chicken', weightPesewas: 3000 }, { key: 'chips', weightPesewas: 1200 }, { key: 'coke', weightPesewas: 800 }]);
  expect([...s.values()].reduce((a, b) => a + b, 0)).toBe(4500);
  expect(s.get('chicken')).toBe(2700);
  expect([...splitComboNet(100, [{ key: 'a', weightPesewas: 0 }, { key: 'b', weightPesewas: 0 }]).values()]).toEqual([100, 0]);
});

it('every channel order needs packing; walk-in eat in does not', () => {
  expect(needsPacking('eat_in')).toBe(false);
  expect(needsPacking('takeaway')).toBe(true);
  expect(needsPacking('eat_in', true)).toBe(true);
});
