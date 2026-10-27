// Dev only: a food shop for the counter-order browser check (npx tsx --conditions=react-server scripts/dev-seed-food.ts).
import { getDb, runMigrations } from '@/db/client';
import { branches, registers, subscriptions, tenants, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { DEFAULT_MODULES, ROLE_PRESETS } from '@/lib/permissions';
import { requireContext } from '@/server/context';
import { hashSecret } from '@/server/crypto';
import { saveFoodSettings, setServiceModes } from '@/server/food-settings';
import { createProduct } from '@/server/products';
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
  await saveFoodSettings(db, ctx, { packVariantId: pack.variants[0].variantId, packFeeMode: 'per_order' });
  await setServiceModes(db, ctx, ids.branchId, ['counter', 'quick']);
  console.log('seeded demo-food');
}
main().then(() => process.exit(0));
