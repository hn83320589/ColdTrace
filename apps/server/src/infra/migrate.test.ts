import { describe, expect, it } from 'vitest';
import { all, openDb } from './db';
import { migrate } from './migrate';

describe('migrate', () => {
  it('依序套用且重複執行不會重套', () => {
    const db = openDb(':memory:');
    const migrations = [
      { version: 2, name: 'b', sql: 'ALTER TABLE t ADD COLUMN y INTEGER' },
      { version: 1, name: 'a', sql: 'CREATE TABLE t (x INTEGER)' },
    ];
    expect(migrate(db, 0, migrations)).toEqual([1, 2]);
    expect(migrate(db, 0, migrations)).toEqual([]);
    expect(all(db, 'SELECT version FROM schema_migrations')).toHaveLength(2);
  });

  it('失敗的 migration 整筆回滾', () => {
    const db = openDb(':memory:');
    const migrations = [{ version: 1, name: 'bad', sql: 'CREATE TABLE t (x); SELECT * FROM nope' }];
    expect(() => migrate(db, 0, migrations)).toThrow();
    expect(all(db, "SELECT name FROM sqlite_master WHERE name = 't'")).toHaveLength(0);
  });
});
