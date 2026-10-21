import { describe, expect, it } from 'vitest';
import { all, openDb, run } from './db';
import { migrate } from './migrate';
import { migrations } from './migrations';

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

  it('v2：移除同一冷藏櫃同一量測時間的重複讀值（保留最早收到的），之後拒絕再寫入', () => {
    const db = openDb(':memory:');
    migrate(
      db,
      0,
      migrations.filter((m) => m.version === 1),
    );
    const insert = (seq: number, receivedAt: number) =>
      run(
        db,
        `INSERT INTO readings (device_id, seq, cabinet_id, measured_at, temp_x10, battery, received_at)
         VALUES ('TM-01', ?, 'C01', 60000, 90, 90, ?)`,
        [seq, receivedAt],
      );
    insert(1001, 200);
    insert(1, 100);

    expect(migrate(db, 0)).toEqual([2]);
    expect(all(db, 'SELECT seq FROM readings')).toEqual([{ seq: 1 }]);
    expect(() => insert(2002, 300)).toThrow(/UNIQUE/);
  });
});
