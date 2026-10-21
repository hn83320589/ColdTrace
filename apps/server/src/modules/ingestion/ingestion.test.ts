import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '@coldtrace/shared';
import { get, type Db } from '../../infra/db';
import { createTestDb, T0 } from '../../test/helpers';
import { repeat, seedBasicAssets, series } from '../../test/fixtures';
import { IngestionService } from './ingestion-service';

const countReadings = (db: Db) =>
  get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM readings')?.n ?? 0;

describe('IngestionService', () => {
  let db: Db;
  let ingestion: IngestionService;
  const now = T0;

  beforeEach(() => {
    db = createTestDb();
    const assets = seedBasicAssets(db);
    ingestion = new IngestionService(db, assets);
  });

  it('同一批資料重送 3 次，資料筆數不變', () => {
    const batch = series('TM-01', now - 60 * MINUTE_MS, repeat(4.5, 60));
    const first = ingestion.ingest(batch, now);
    expect(first.response).toMatchObject({ accepted: 60, duplicated: 0 });

    for (let i = 0; i < 3; i++) {
      const again = ingestion.ingest(batch, now);
      expect(again.response).toMatchObject({ accepted: 0, duplicated: 60, rejectedCount: 0 });
    }
    expect(countReadings(db)).toBe(60);
  });

  it('75 小時前的資料被拒收，並列出筆數與流水號', () => {
    const old = series('TM-01', now - 75 * HOUR_MS, [4.0, 4.1, 4.2], 101);
    const fresh = series('TM-01', now - 10 * MINUTE_MS, [4.5], 500);
    const { response } = ingestion.ingest([...old, ...fresh], now);

    expect(response.accepted).toBe(1);
    expect(response.rejectedCount).toBe(3);
    expect(response.rejected).toEqual([
      { deviceId: 'TM-01', seq: 101, reason: 'TOO_OLD' },
      { deviceId: 'TM-01', seq: 102, reason: 'TOO_OLD' },
      { deviceId: 'TM-01', seq: 103, reason: 'TOO_OLD' },
    ]);
  });

  it('剛好 72 小時前的資料仍接受', () => {
    const { response } = ingestion.ingest(series('TM-01', now - 72 * HOUR_MS, [4.0]), now);
    expect(response.accepted).toBe(1);
  });

  it('超前伺服器 5 分鐘以上的資料視為時鐘異常拒收', () => {
    const { response } = ingestion.ingest(series('TM-01', now + 6 * MINUTE_MS, [4.0]), now);
    expect(response.rejected[0]?.reason).toBe('FROM_FUTURE');
  });

  it('未知裝置與無綁定期間的資料分別拒收', () => {
    const unknown = series('TM-99', now - MINUTE_MS, [4.0]);
    const beforeBinding = series('TM-01', now - 71 * HOUR_MS, [4.0], 7);
    // TM-01 自 T0 − 4 天綁定，因此 71 小時前仍在綁定期內；另建一支沒有綁定的裝置
    db.exec(`INSERT INTO devices (id, created_at) VALUES ('TM-SPARE', 0)`);
    const unbound = series('TM-SPARE', now - MINUTE_MS, [4.0]);

    const { response } = ingestion.ingest([...unknown, ...beforeBinding, ...unbound], now);
    expect(response.rejected.map((r) => r.reason)).toEqual(['UNKNOWN_DEVICE', 'UNBOUND']);
    expect(response.accepted).toBe(1);
  });

  it('溫度不是小數一位時拒收', () => {
    const { response } = ingestion.ingest(series('TM-01', now - MINUTE_MS, [4.25]), now);
    expect(response.rejected[0]?.reason).toBe('INVALID_TEMPERATURE');
  });

  it('同流水號但內容不同時，不覆寫原始紀錄並回報衝突', () => {
    ingestion.ingest(series('TM-01', now - MINUTE_MS, [4.0]), now);
    const result = ingestion.ingest(series('TM-01', now - MINUTE_MS, [9.9]), now);

    expect(result.response.duplicated).toBe(1);
    expect(result.conflicts).toEqual([{ deviceId: 'TM-01', seq: 1 }]);
    expect(get<{ t: number }>(db, 'SELECT temp_x10 AS t FROM readings')?.t).toBe(40);
  });

  it('同一冷藏櫃同一量測時間換了流水號重送（韌體重開機），視為重複不寫入', () => {
    const original = series('TM-01', now - 14 * MINUTE_MS, repeat(9.0, 14), 1);
    ingestion.ingest(original, now);
    const resent = series('TM-01', now - 14 * MINUTE_MS, repeat(9.0, 14), 1001);
    const result = ingestion.ingest(resent, now);

    expect(result.response).toMatchObject({ accepted: 0, duplicated: 14, rejectedCount: 0 });
    expect(result.conflicts).toEqual([]);
    expect(result.affected.size).toBe(0);
    expect(countReadings(db)).toBe(14);
  });

  it('同一量測時間、不同流水號且溫度不同時，保留原始紀錄並回報衝突', () => {
    ingestion.ingest(series('TM-01', now - MINUTE_MS, [4.0], 1), now);
    const result = ingestion.ingest(series('TM-01', now - MINUTE_MS, [9.9], 500), now);

    expect(result.response).toMatchObject({ accepted: 0, duplicated: 1 });
    expect(result.conflicts).toEqual([{ deviceId: 'TM-01', seq: 500 }]);
    expect(get<{ t: number }>(db, 'SELECT temp_x10 AS t FROM readings')?.t).toBe(40);
  });

  it('同一批次內出現同一量測時間的兩筆資料，只寫入第一筆', () => {
    const [a] = series('TM-01', now - MINUTE_MS, [4.0], 1);
    const [b] = series('TM-01', now - MINUTE_MS, [4.0], 2);
    const { response } = ingestion.ingest([a!, b!], now);

    expect(response).toMatchObject({ accepted: 1, duplicated: 1 });
    expect(countReadings(db)).toBe(1);
  });

  it('回報各冷藏櫃實際新增資料的時間範圍', () => {
    const a = series('TM-01', now - 30 * MINUTE_MS, [4.0, 4.0]);
    const b = series('TM-02', now - 5 * MINUTE_MS, [5.0]);
    const result = ingestion.ingest([...a, ...b], now);

    expect(result.affected.get('C01')).toEqual({
      from: now - 30 * MINUTE_MS,
      to: now - 29 * MINUTE_MS,
    });
    expect(result.affected.get('C02')).toEqual({
      from: now - 5 * MINUTE_MS,
      to: now - 5 * MINUTE_MS,
    });

    const resend = ingestion.ingest(a, now);
    expect(resend.affected.size).toBe(0);
  });
});
