import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { asPlatform, withTenant } from '@/db/tenant';
import { createTestDb, rows } from '../helpers/test-db';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => { ({ db, close } = await createTestDb()); });
afterEach(async () => { await close(); });

it('withTenant runs as pos_app with app.tenant_id set', async () => {
  const row = await withTenant(db, A, async (tx) =>
    rows(await tx.execute(sql`select current_user as u, current_setting('app.tenant_id') as t`))[0]);
  expect(row).toEqual({ u: 'pos_app', t: A });
});

it('PGlite enforces RLS for pos_app', async () => {
  await asPlatform(db, async (tx) => {
    await tx.execute(sql`create table probe (tenant_id uuid not null)`);
    await tx.execute(sql`alter table probe enable row level security`);
    await tx.execute(sql`create policy p on probe using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
    await tx.execute(sql`grant select on probe to pos_app`);
    await tx.execute(sql`insert into probe values (${A}), (${B})`);
  });
  const row = await withTenant(db, A, async (tx) =>
    rows(await tx.execute(sql`select count(*)::int as n from probe`))[0]);
  expect(row).toEqual({ n: 1 });
});

it('rejects a tenant id that is not a uuid', async () => {
  await expect(withTenant(db, 'abc', async () => 1)).rejects.toThrow('invalid tenant id');
});
