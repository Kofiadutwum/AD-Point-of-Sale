import { getDb, runMigrations } from '../src/db/client';

async function main() {
  await runMigrations(getDb(), process.env.DATABASE_URL ? 'postgres' : 'pglite');
  console.log('migrations applied');
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
