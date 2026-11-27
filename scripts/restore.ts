import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { getDb, runMigrations } from '../src/db/client';
import { restoreBackup } from '../src/server/backup';

// npm run db:restore -- <backup-file.json.gz> --yes
// Into an EMPTY database only (a new Neon branch or database): migrates it first, then restores in one transaction.
// It refuses a database that already holds shops, so it cannot overwrite live data.
async function main() {
  const file = process.argv[2];
  if (!file || !process.argv.includes('--yes')) {
    console.error('usage: npm run db:restore -- <backup-file.json.gz> --yes   (target: DATABASE_URL, which must be an empty database)');
    process.exit(2);
  }
  const raw = readFileSync(file);
  const backup = JSON.parse((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  const db = getDb();
  await runMigrations(db, process.env.DATABASE_URL ? 'postgres' : 'pglite');
  const r = await restoreBackup(db, backup);
  console.log(`restored ${r.rows} rows into ${r.tables} tables from a backup taken ${backup.takenAt}`);
}

main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
