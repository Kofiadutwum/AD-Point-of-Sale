import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { getDb } from '../src/db/client';
import { takeBackup } from '../src/server/backup';

// npm run db:backup [-- <folder>] → <folder>/backup-<time>.json.gz (default ./backups, which git ignores).
// Copy the file to encrypted storage away from the database host; it holds password hashes and sealed secrets.
async function main() {
  const dir = process.argv[2] ?? 'backups';
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const backup = await takeBackup(getDb(), now);
  const file = path.join(dir, `backup-${now.toISOString().replace(/[:.]/g, '-')}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify(backup)));
  const rows = Object.values(backup.tables).reduce((a, t) => a + t.length, 0);
  console.log(`backup written: ${file} (${Object.keys(backup.tables).length} tables, ${rows} rows, migration ${backup.migrations})`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
