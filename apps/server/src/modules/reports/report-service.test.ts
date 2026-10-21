import { beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, MINUTE_MS, taipeiMonthRange } from '@coldtrace/shared';
import { FixedClock } from '../../infra/clock';
import { run, transaction, type Db } from '../../infra/db';
import { migrate } from '../../infra/migrate';
import { openDb } from '../../infra/db';
import { createServices, type Services } from '../../services';
import { computeRates } from './report-service';

const { from: OCT, to: NOV } = taipeiMonthRange('2026-10');

/** 直接寫入量測（略過 72h 限制），用於建立整月的測試資料 */
function insertMinutes(
  db: Db,
  start: number,
  count: number,
  tempX10: (i: number) => number,
  seq0 = 1,
) {
  transaction(db, () => {
    for (let i = 0; i < count; i++) {
      const t = start + i * MINUTE_MS;
      run(
        db,
        `INSERT INTO readings (device_id, seq, cabinet_id, measured_at, temp_x10, battery, received_at)
         VALUES ('TM-01', ?, 'C01', ?, ?, 90, ?)`,
        [seq0 + i, t, tempX10(i), t],
      );
    }
  });
}

describe('月報', () => {
  let db: Db;
  let s: Services;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db, 0);
    s = createServices(db, new FixedClock(NOV + DAY_MS));
    s.assets.createBranch({ id: 'B01', name: '台北分院' });
    s.assets.createCabinet({ id: 'C01', branchId: 'B01', name: '疫苗冷藏櫃 A' });
    s.assets.createDevice({ id: 'TM-01' }, 0);
    s.assets.bindDevice('TM-01', 'C01', OCT - DAY_MS);
  });

  it('computeRates：手算範例（設計文件 §9.2）', () => {
    const rates = computeRates({
      expectedMinutes: 44_640,
      recordedMinutes: 44_000,
      inRangeMinutes: 43_780,
    });
    expect(rates.completenessRate! * 100).toBeCloseTo(98.566, 3);
    expect(rates.complianceRate! * 100).toBeCloseTo(99.5, 6);
  });

  it('整月：44,640 應有分鐘、44,000 有資料、其中 220 分鐘超標', () => {
    // 前 44,000 分鐘有資料，其中第 1000–1219 分鐘超標（220 分鐘），最後 640 分鐘無資料
    insertMinutes(db, OCT, 44_000, (i) => (i >= 1000 && i < 1220 ? 95 : 45));
    const [cabinet] = s.reports.monthly('2026-10', NOV + DAY_MS).cabinets;

    expect(cabinet).toMatchObject({
      expectedMinutes: 44_640,
      recordedMinutes: 44_000,
      inRangeMinutes: 43_780,
    });
    expect(cabinet!.completenessRate).toBeCloseTo(44_000 / 44_640, 10);
    expect(cabinet!.complianceRate).toBeCloseTo(43_780 / 44_000, 10);
  });

  it('月份邊界以台灣時間切分，月外資料不計入', () => {
    insertMinutes(db, OCT - 10 * MINUTE_MS, 20, () => 45); // 9/30 23:50 – 10/01 00:09
    const [cabinet] = s.reports.monthly('2026-10', NOV + DAY_MS).cabinets;
    expect(cabinet?.recordedMinutes).toBe(10);
  });

  it('當月未結束只算到現在；綁定前的時間不列入應有分鐘', () => {
    s.assets.createCabinet({ id: 'C02', branchId: 'B01', name: '疫苗冷藏櫃 B' });
    s.assets.createDevice({ id: 'TM-02' }, 0);
    s.assets.bindDevice('TM-02', 'C02', OCT + 40 * MINUTE_MS);

    const report = s.reports.monthly('2026-10', OCT + 100 * MINUTE_MS);
    expect(report.cabinets.map((c) => c.expectedMinutes)).toEqual([100, 60]);
    expect(report.cabinets[0]?.complianceRate).toBeNull(); // 沒有資料時合規率不可算
  });

  it('CSV 列出摘要與事件清單', () => {
    insertMinutes(db, OCT, 60, (i) => (i >= 10 && i < 25 ? 95 : 45));
    s.excursions.reconcile('C01', { from: OCT, to: OCT + 59 * MINUTE_MS }, OCT + DAY_MS, []);
    const report = s.reports.monthly('2026-10', NOV + DAY_MS);

    const summary = s.reports.summaryCsv(report).split('\r\n');
    // 月份寫成「2026年10月」：「2026-10」會被 Excel 轉成日期並顯示為 Oct-26
    expect(summary[1]).toMatch(/^2026年10月,台北分院,疫苗冷藏櫃 A,C01,44640,60,45/);
    const events = s.reports.eventsCsv(report).split('\r\n');
    expect(events[1]).toContain(
      '溫度異常,台北分院,疫苗冷藏櫃 A,2026-10-01 00:10,2026-10-01 00:25,15',
    );
  });
});
