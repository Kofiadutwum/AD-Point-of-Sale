import { getDb, runMigrations } from '../src/db/client';
import { createPlatformAdmin } from '../src/server/platform-admin';

// usage: PLATFORM_ADMIN_PASSWORD=... npm run create-platform-admin -- <email> "<name>"
async function main() {
  const [email, name] = process.argv.slice(2);
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
  if (!email || !name) throw new Error('usage: npm run create-platform-admin -- <email> "<name>"');
  if (password.length < 12) throw new Error('set PLATFORM_ADMIN_PASSWORD to at least 12 characters');
  const db = getDb();
  await runMigrations(db, process.env.DATABASE_URL ? 'postgres' : 'pglite');
  const { id } = await createPlatformAdmin(db, { email, name, password });
  console.log(`platform admin created: ${id}`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
