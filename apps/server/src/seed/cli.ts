import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../infra/db';
import { migrate } from '../infra/migrate';
import { isEmpty, seedSampleData } from './seed';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(process.env.COLDTRACE_DB ?? resolve(here, '../../../../data/coldtrace.db'));
const reset = process.argv.includes('--reset');

if (reset) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  console.log(`已刪除資料庫 ${dbPath}`);
}

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
migrate(db, Date.now());

if (!isEmpty(db)) {
  console.log('資料庫已有資料，略過。如需重建請執行 npm run db:reset');
} else {
  const started = Date.now();
  const summary = seedSampleData(db, Date.now());
  console.log(`範例資料產生完成（${Date.now() - started} ms）`, summary);
}
db.close();
