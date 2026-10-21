import { describe, expect, it } from 'vitest';
import { DAY_MS } from '@coldtrace/shared';
import { all, run } from '../infra/db';
import { createTestDb, T0 } from '../test/helpers';
import { purgeExpiredReadings, RETENTION_MS } from './retention';

describe('purgeExpiredReadings', () => {
  it('只刪除超過兩年的量測資料', () => {
    const db = createTestDb();
    const insert = (seq: number, t: number) =>
      run(
        db,
        `INSERT INTO readings (device_id, seq, cabinet_id, measured_at, temp_x10, battery, received_at)
         VALUES ('TM-01', ?, 'C01', ?, 45, 90, ?)`,
        [seq, t, t],
      );
    insert(1, T0 - RETENTION_MS - DAY_MS);
    insert(2, T0 - RETENTION_MS + DAY_MS);

    expect(purgeExpiredReadings(db, T0)).toBe(1);
    expect(all<{ seq: number }>(db, 'SELECT seq FROM readings').map((r) => r.seq)).toEqual([2]);
  });
});
