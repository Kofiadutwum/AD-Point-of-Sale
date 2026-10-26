import { expect, it } from 'vitest';
import { formatOrderNumber, needsPacking, offlineOrderNumber, ORDER_NUMBER, packCount } from '@/lib/food';

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
