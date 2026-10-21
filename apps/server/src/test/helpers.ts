import { openDb, type Db } from '../infra/db';
import { migrate } from '../infra/migrate';

export const T0 = Date.parse('2026-10-01T00:00:00+08:00');

export function createTestDb(): Db {
  const db = openDb(':memory:');
  migrate(db, T0);
  return db;
}
