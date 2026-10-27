import { expect, it } from 'vitest';
import { DEFAULT_MODULES, MODULES, PERMISSIONS, ROLE_PRESETS, TILL_PERMISSIONS } from '@/lib/permissions';

it('gives owners every permission and managers all but shop settings', () => {
  expect([...ROLE_PRESETS.owner].sort()).toEqual([...PERMISSIONS].sort());
  expect(ROLE_PRESETS.manager).not.toContain('manage_shop_settings');
  expect(ROLE_PRESETS.manager).toHaveLength(PERMISSIONS.length - 1);
});

it('lets cashiers only sell, mark items sold out, and run the kitchen', () => {
  expect(ROLE_PRESETS.cashier).toEqual(['make_sale', 'mark_sold_out', 'run_kitchen', 'record_kitchen_stock', 'enter_channel_orders']);
});

it('a cashier PIN can mark sold out and run the kitchen', () => {
  for (const p of ['mark_sold_out', 'run_kitchen'] as const) {
    expect(ROLE_PRESETS.cashier).toContain(p);
    expect(TILL_PERMISSIONS).toContain(p);
  }
});

it('switches on the right modules per shop type', () => {
  expect(DEFAULT_MODULES).toEqual({
    retail: ['serials', 'price_lists', 'scale_barcodes'],
    pharmacy: ['batches', 'prescriptions', 'units'],
    food: ['addons', 'tickets', 'kitchen', 'recipes'],
  });
});

it('every default module is a known module', () => {
  for (const list of Object.values(DEFAULT_MODULES)) for (const m of list) expect(MODULES).toContain(m);
});

it('a cashier PIN can record kitchen stock', () => {
  expect(ROLE_PRESETS.cashier).toContain('record_kitchen_stock');
  expect(TILL_PERMISSIONS).toContain('record_kitchen_stock');
});

it('a cashier PIN can enter channel orders but not manage channels', () => {
  expect(TILL_PERMISSIONS).toContain('enter_channel_orders');
  expect(ROLE_PRESETS.cashier).not.toContain('manage_channels');
  expect(ROLE_PRESETS.manager).toContain('manage_channels');
  expect(TILL_PERMISSIONS).not.toContain('manage_channels');
});
