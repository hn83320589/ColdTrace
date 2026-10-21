import { describe, expect, it, vi } from 'vitest';
import { MINUTE_MS, type IngestResponse, type ReadingInput } from '@coldtrace/shared';
import { SimulatedDevice, type Uploader } from './device';
import { buildPlan, OFFLINE_DURATION_MIN } from './scenarios';

const T = Date.parse('2026-10-21T10:00:00+08:00');
const ok = (readings: ReadingInput[]): IngestResponse => ({
  accepted: readings.length,
  duplicated: 0,
  rejectedCount: 0,
  rejected: [],
});

describe('SimulatedDevice', () => {
  it('流水號延續既有值、每分鐘一筆', async () => {
    const sent: ReadingInput[] = [];
    const device = new SimulatedDevice('TM-1', 100, T, buildPlan('normal', 1, T, T));
    await device.tick(T + 2 * MINUTE_MS, (r) => {
      sent.push(...r);
      return Promise.resolve(ok(r));
    });
    expect(sent.map((r) => r.seq)).toEqual([101, 102, 103]);
  });

  it('斷線期間緩衝，恢復後依序補傳', async () => {
    const plan = buildPlan('offline-backfill', 1, T, T);
    const upload = vi.fn<Uploader>((r) => Promise.resolve(ok(r)));
    const device = new SimulatedDevice('TM-1', 0, T, plan);

    await device.tick(T + 60 * MINUTE_MS, upload);
    expect(upload).not.toHaveBeenCalled();
    expect(device.pending).toBe(61);

    await device.tick(T + OFFLINE_DURATION_MIN * MINUTE_MS, upload);
    expect(device.pending).toBe(0);
    expect(device.stats.accepted).toBe(OFFLINE_DURATION_MIN + 1);
  });

  it('上傳失敗時保留資料，下次重送', async () => {
    const device = new SimulatedDevice('TM-1', 0, T, buildPlan('normal', 1, T, T));
    await device.tick(T, () => Promise.reject(new Error('ECONNREFUSED')));
    expect(device.pending).toBe(1);
    expect(device.stats.failedUploads).toBe(1);

    await device.tick(T + MINUTE_MS, (r) => Promise.resolve(ok(r)));
    expect(device.pending).toBe(0);
    expect(device.stats.accepted).toBe(2);
  });

  it('壓縮機故障情境在 30 分鐘內超標達 10 分鐘以上', () => {
    const plan = buildPlan('compressor-failure', 1, T, T);
    const above = Array.from({ length: 30 }, (_, i) => plan.model.sample(T + i * MINUTE_MS)).filter(
      (v) => v > 8,
    );
    expect(above.length).toBeGreaterThanOrEqual(10);
  });
});
