import { expect, it } from 'vitest';
import { DEFAULT_MODULES, MODULES, PERMISSIONS, ROLE_PRESETS } from '@/lib/permissions';

it('gives owners every permission and managers all but shop settings', () => {
  expect([...ROLE_PRESETS.owner].sort()).toEqual([...PERMISSIONS].sort());
  expect(ROLE_PRESETS.manager).not.toContain('manage_shop_settings');
  expect(ROLE_PRESETS.manager).toHaveLength(PERMISSIONS.length - 1);
});

it('lets cashiers only sell', () => {
  expect(ROLE_PRESETS.cashier).toEqual(['make_sale']);
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
