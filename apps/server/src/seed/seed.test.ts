import { describe, expect, it } from 'vitest';
import { all } from '../infra/db';
import type { EventRow } from '../modules/events/event-repository';
import { createTestDb, T0 } from '../test/helpers';
import { seedSampleData } from './seed';

describe('seedSampleData', () => {
  it('產生 8 間分院、16 台冷藏櫃、7 天資料，並包含預埋事件', () => {
    const db = createTestDb();
    const summary = seedSampleData(db, T0);

    expect(all(db, 'SELECT * FROM branches')).toHaveLength(8);
    expect(all(db, 'SELECT * FROM cabinets')).toHaveLength(16);
    expect(summary.readings).toBeGreaterThan(16 * 1440 * 7 - 500);

    const events = all<EventRow>(db, `SELECT * FROM events WHERE status != 'MERGED'`);
    const cabinetsWith = (type: string) =>
      [...new Set(events.filter((e) => e.type === type).map((e) => e.cabinet_id))].sort();
    expect(cabinetsWith('EXCURSION')).toEqual(['C03', 'C10', 'C12']);
    expect(cabinetsWith('OFFLINE')).toEqual(['C07', 'C10', 'C14']);

    const statusOf = (cabinet: string) =>
      events.find((e) => e.type === 'OFFLINE' && e.cabinet_id === cabinet)?.status;
    expect(statusOf('C07')).toBe('BACKFILLED_NORMAL');
    expect(statusOf('C10')).toBe('BACKFILLED_EXCURSION');
    expect(statusOf('C14')).toBe('INCOMPLETE');
    expect(all(db, `SELECT * FROM bindings WHERE cabinet_id = 'C05'`)).toHaveLength(2);
  }, 30_000);
});
