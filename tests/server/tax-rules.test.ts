import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { products } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { listTaxRules, saveTaxRule } from '@/server/tax-rules';
import { ctxFor, expectAccess, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
const vat = { name: 'VAT', rateBp: 1500, levies: [{ name: 'NHIL', rateBp: 250 }], vatOnLevies: false, isDefault: true, active: true };
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'owner@a.test', rolePreset: 'owner' },
    { key: 'manager', phone: '0241111111', rolePreset: 'manager' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

it('saves a rule with levies and keeps a single default', async () => {
  const first = await saveTaxRule(db, owner, vat) as { taxRuleId: string };
  expect(await saveTaxRule(db, owner, { ...vat, name: 'Exempt', rateBp: 0, levies: [] })).toMatchObject({ ok: true });
  const rules = await listTaxRules(db, owner);
  expect(rules.filter((r) => r.isDefault).map((r) => r.name)).toEqual(['Exempt']);
  expect(rules.find((r) => r.id === first.taxRuleId)).toMatchObject({ rateBp: 1500, levies: [{ name: 'NHIL', rateBp: 250 }] });
});

it('rejects bad rates, too many levies, and duplicate names', async () => {
  expect(await saveTaxRule(db, owner, { ...vat, rateBp: 10001 })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await saveTaxRule(db, owner, { ...vat, levies: Array(6).fill({ name: 'L', rateBp: 1 }) })).toEqual({ ok: false, error: 'invalid_input' });
  expect(await saveTaxRule(db, owner, { ...vat, isDefault: true, active: false })).toEqual({ ok: false, error: 'invalid_input' });
  await saveTaxRule(db, owner, vat);
  expect(await saveTaxRule(db, owner, { ...vat, name: 'vat' })).toEqual({ ok: false, error: 'duplicate_name' });
});

it('edits a rule in place and refuses unknown ids', async () => {
  const { taxRuleId } = await saveTaxRule(db, owner, vat) as { taxRuleId: string };
  expect(await saveTaxRule(db, owner, { ...vat, id: taxRuleId, rateBp: 1250 })).toEqual({ ok: true, taxRuleId });
  expect((await listTaxRules(db, owner)).map((r) => r.rateBp)).toEqual([1250]);
  expect(await saveTaxRule(db, owner, { ...vat, id: '33333333-3333-4333-8333-333333333333' })).toEqual({ ok: false, error: 'not_found' });
});

it('will not switch off a rule that products use', async () => {
  const { taxRuleId } = await saveTaxRule(db, owner, { ...vat, isDefault: false }) as { taxRuleId: string };
  await asPlatform(db, (tx) => tx.insert(products).values({ tenantId: shop.tenantId, name: 'Milo', taxRuleId }));
  expect(await saveTaxRule(db, owner, { ...vat, id: taxRuleId, isDefault: false, active: false })).toEqual({ ok: false, error: 'in_use' });
});

it('needs manage_shop_settings', async () => {
  await expectAccess(saveTaxRule(db, await ctxFor(db, shop, 'manager', t0), vat), 'forbidden');
});
