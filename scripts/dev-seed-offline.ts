// Dev only: a shop for the offline till browser check (npx tsx --conditions=react-server scripts/dev-seed-offline.ts).
import { getDb, runMigrations } from '@/db/client';
import { branches, registers, subscriptions, tenants, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { DEFAULT_MODULES, ROLE_PRESETS } from '@/lib/permissions';
import { requireContext } from '@/server/context';
import { hashSecret } from '@/server/crypto';
import { createProduct } from '@/server/products';
import { createSession } from '@/server/sessions';
import { addBarcode } from '@/server/variants';

async function main() {
  const db = getDb();
  await runMigrations(db, 'pglite');
  const [ownerHash, ownerPin, amaPin] = await Promise.all([hashSecret('correct-horse-1'), hashSecret('9999'), hashSecret('5678')]);
  const ids = await asPlatform(db, async (tx) => {
    const [t] = await tx.insert(tenants).values({ slug: 'demo-till', name: 'Demo Till Shop', shopType: 'retail', modules: [...DEFAULT_MODULES.retail] }).returning();
    await tx.insert(subscriptions).values({ tenantId: t.id, planId: 'standard', status: 'active', endDate: '2099-12-31' });
    const [b] = await tx.insert(branches).values({ tenantId: t.id, name: 'Main', branchCode: 'B1' }).returning();
    await tx.insert(registers).values({ tenantId: t.id, branchId: b.id, name: 'Till 1', registerCode: 'T1' });
    const [o] = await tx.insert(users).values({ tenantId: t.id, name: 'Owner', email: 'owner@demo.test', rolePreset: 'owner', permissions: [...ROLE_PRESETS.owner],
      branchIds: [b.id], passwordHash: ownerHash, pinHash: ownerPin, status: 'active' }).returning();
    await tx.insert(users).values({ tenantId: t.id, name: 'Ama', phone: '233241234567', rolePreset: 'cashier', permissions: [...ROLE_PRESETS.cashier],
      branchIds: [b.id], pinHash: amaPin, status: 'active' });
    return { tenantId: t.id, ownerId: o.id };
  });
  const now = new Date();
  const { token } = await createSession(db, { tenantId: ids.tenantId, userId: ids.ownerId, kind: 'password' }, now);
  const ctx = await requireContext(db, { slug: 'demo-till', sessionToken: token, permission: 'manage_products' }, now);
  const p = await createProduct(db, ctx, { name: 'Milo 400g', kind: 'standard', tracking: 'none', baseUnit: 'tin', allowsFractions: false,
    variants: [{ basePricePesewas: 2500, costPesewas: 2000 }] });
  if (!p.ok) throw new Error(p.error);
  await addBarcode(db, ctx, p.variants[0].baseUnitId, '6001234567890');
  console.log('seeded demo-till');
}
main().then(() => process.exit(0));
