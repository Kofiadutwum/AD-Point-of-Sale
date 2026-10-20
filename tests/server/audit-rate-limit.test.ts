import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { auditLog } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { writeAudit } from '@/server/audit';
import { clearAttempts, countFailedAttempt, tooManyAttempts } from '@/server/rate-limit';
import { type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

let db: Db;
let close: () => Promise<void>;
let a: SeededShop;
let b: SeededShop;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  a = await seedShop(db, { slug: 'shop-a' });
  b = await seedShop(db, { slug: 'shop-b' });
});
afterEach(async () => { await close(); });

it('audit entries are visible only to their tenant', async () => {
  await withTenant(db, a.tenantId, (tx) =>
    writeAudit(tx, { tenantId: a.tenantId, actorType: 'user', actorId: a.users.owner.id, action: 'test_event' }));
  expect(await withTenant(db, a.tenantId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'test_event')))).toHaveLength(1);
  expect(await withTenant(db, b.tenantId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'test_event')))).toEqual([]);
});

it('limits to 10 failures per key per 15 minutes', async () => {
  const t0 = new Date('2026-10-20T10:00:00Z');
  await asPlatform(db, async (tx) => {
    for (let i = 0; i < 9; i++) await countFailedAttempt(tx, 'k', t0);
    expect(await tooManyAttempts(tx, 'k', t0)).toBe(false);
    await countFailedAttempt(tx, 'k', t0);
    expect(await tooManyAttempts(tx, 'k', t0)).toBe(true);
    expect(await tooManyAttempts(tx, 'k', new Date(t0.getTime() + 16 * 60_000))).toBe(false);
    await clearAttempts(tx, 'k');
    expect(await tooManyAttempts(tx, 'k', t0)).toBe(false);
  });
});

it('starts a new window once the old one has passed', async () => {
  const t0 = new Date('2026-10-20T10:00:00Z');
  const later = new Date(t0.getTime() + 16 * 60_000);
  await asPlatform(db, async (tx) => {
    for (let i = 0; i < 10; i++) await countFailedAttempt(tx, 'k', t0);
    await countFailedAttempt(tx, 'k', later); // first failure of a fresh window
    expect(await tooManyAttempts(tx, 'k', later)).toBe(false);
  });
});
