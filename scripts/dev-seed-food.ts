// Dev only: a food shop for the counter-order browser check (npx tsx --conditions=react-server scripts/dev-seed-food.ts).
import { getDb, runMigrations } from '@/db/client';
import { branches, registers, subscriptions, tenants, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { DEFAULT_MODULES, ROLE_PRESETS } from '@/lib/permissions';
import { requireContext } from '@/server/context';
import { hashSecret } from '@/server/crypto';
import { saveFoodSettings, setServiceModes } from '@/server/food-settings';
import { saveComboSlots } from '@/server/combos';
import { createProduct } from '@/server/products';
import { addComponent, updateVariant } from '@/server/variants';
import { createSession } from '@/server/sessions';

async function main() {
  const db = getDb();
  await runMigrations(db, 'pglite');
  const [ownerHash, ownerPin] = await Promise.all([hashSecret('correct-horse-1'), hashSecret('9999')]);
  const ids = await asPlatform(db, async (tx) => {
    const [t] = await tx.insert(tenants).values({ slug: 'demo-food', name: 'Demo Chop Bar', shopType: 'food', modules: [...DEFAULT_MODULES.food] }).returning();
    await tx.insert(subscriptions).values({ tenantId: t.id, planId: 'standard', status: 'active', endDate: '2099-12-31' });
    const [b] = await tx.insert(branches).values({ tenantId: t.id, name: 'Main', branchCode: 'B1' }).returning();
    await tx.insert(registers).values({ tenantId: t.id, branchId: b.id, name: 'Till 1', registerCode: 'T1' });
    const [o] = await tx.insert(users).values({ tenantId: t.id, name: 'Owner', email: 'owner@food.test', rolePreset: 'owner', permissions: [...ROLE_PRESETS.owner],
      branchIds: [b.id], passwordHash: ownerHash, pinHash: ownerPin, status: 'active' }).returning();
    return { tenantId: t.id, branchId: b.id, ownerId: o.id };
  });
  const { token } = await createSession(db, { tenantId: ids.tenantId, userId: ids.ownerId, kind: 'password' }, new Date());
  const ctx = await requireContext(db, { slug: 'demo-food', sessionToken: token, permission: null }, new Date());
  const item = (name: string, price: number) => createProduct(db, ctx, { name, kind: 'standard', tracking: 'none', baseUnit: 'plate', allowsFractions: false,
    variants: [{ basePricePesewas: price, costPesewas: Math.round(price / 2) }] });
  const pack = await createProduct(db, ctx, { name: 'Takeaway pack', kind: 'standard', tracking: 'none', baseUnit: 'pack', allowsFractions: false,
    variants: [{ basePricePesewas: 100, costPesewas: 50 }] });
  if (!pack.ok) throw new Error(pack.error);
  for (const [name, price] of [['Jollof and chicken', 4500], ['Waakye', 3000], ['Banku and tilapia', 6000]] as const) {
    const r = await item(name, price);
    if (!r.ok) throw new Error(r.error);
  }
  // a combo with a drink choice and an upgrade, and jollof sold by amount from pots of rice and oil
  const drink = async (name: string, price: number) => (await createProduct(db, ctx, { name, kind: 'standard', tracking: 'none', baseUnit: 'bottle',
    allowsFractions: false, variants: [{ basePricePesewas: price, costPesewas: Math.round(price / 2) }] }) as { variants: Array<{ variantId: string }> }).variants[0].variantId;
  const [coke, largeCoke] = [await drink('Coke', 800), await drink('Large Coke', 1200)];
  const chicken = await createProduct(db, ctx, { name: 'Chicken piece', kind: 'standard', tracking: 'none', baseUnit: 'piece', allowsFractions: false,
    variants: [{ sku: 'CHK', basePricePesewas: 1500, costPesewas: 800 }] });
  const meal = await createProduct(db, ctx, { name: 'Meal 2', kind: 'combo', tracking: 'none', baseUnit: 'meal', allowsFractions: false, variants: [{ basePricePesewas: 4500, costPesewas: 0 }] });
  if (!chicken.ok || !meal.ok) throw new Error('combo seed failed');
  await addComponent(db, ctx, meal.variants[0].variantId, { code: 'CHK', quantity: '2' });
  await saveComboSlots(db, ctx, meal.variants[0].variantId, [{ name: 'Drink', minChoices: 1, maxChoices: 1,
    choices: [{ variantId: coke, upgradePesewas: 0 }, { variantId: largeCoke, upgradePesewas: 500 }] }]);
  for (const [name, sku, unit] of [['Rice', 'RICE', 'kg'], ['Oil', 'OIL', 'L']] as const) {
    await createProduct(db, ctx, { name, kind: 'standard', tracking: 'none', baseUnit: unit, allowsFractions: true, variants: [{ sku, basePricePesewas: 2000, costPesewas: 1000 }] });
  }
  const jollof = await createProduct(db, ctx, { name: 'Jollof (by amount)', kind: 'recipe', tracking: 'none', baseUnit: 'plate', allowsFractions: false,
    variants: [{ basePricePesewas: 1000, costPesewas: 0 }] });
  if (!jollof.ok) throw new Error(jollof.error);
  const jollofId = jollof.variants[0].variantId;
  await addComponent(db, ctx, jollofId, { code: 'RICE', quantity: '5' });
  await addComponent(db, ctx, jollofId, { code: 'OIL', quantity: '1' });
  await updateVariant(db, ctx, jollofId, { name: '', sku: null, basePricePesewas: 1000, costPesewas: null, reorderLevel: null, sellable: true, allowsFractions: false,
    sellByAmount: true, minAmountPesewas: 500, valuePerPotPesewas: 60000 });
  await saveFoodSettings(db, ctx, { packVariantId: pack.variants[0].variantId, packFeeMode: 'per_order' });
  await setServiceModes(db, ctx, ids.branchId, ['counter', 'quick']);
  console.log('seeded demo-food');
}
main().then(() => process.exit(0));
