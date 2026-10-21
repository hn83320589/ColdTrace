import { describe, expect, it } from 'vitest';
import { MINUTE_MS, type EventDto } from '@coldtrace/shared';
import { verifyScenario } from './verify';

const T = Date.parse('2026-10-21T10:00:00+08:00');
const event = (e: Partial<EventDto>): EventDto => ({
  id: 1,
  cabinetId: 'C01',
  type: 'EXCURSION',
  status: 'CLOSED',
  startedAt: T,
  endedAt: null,
  detectedAt: T,
  durationMs: null,
  maxTempX10: null,
  minTempX10: null,
  degreeMinutesX10: null,
  backfilled: false,
  linkedEventIds: [],
  latestDisposition: null,
  ...e,
});

describe('verifyScenario', () => {
  it('開門情境不應產生事件', () => {
    expect(verifyScenario('door-open', [], 30).ok).toBe(true);
    expect(verifyScenario('door-open', [event({})], 30).ok).toBe(false);
  });

  it('壓縮機故障：時間未到時為待定，時間到仍無事件則失敗', () => {
    expect(verifyScenario('compressor-failure', [], 10)).toMatchObject({ ok: true, pending: true });
    expect(verifyScenario('compressor-failure', [], 60).ok).toBe(false);
    expect(verifyScenario('compressor-failure', [event({})], 30).ok).toBe(true);
  });

  it('斷線補傳：檢查狀態、異常時間、持續時間與關聯', () => {
    const offline = event({
      id: 1,
      type: 'OFFLINE',
      status: 'BACKFILLED_EXCURSION',
      linkedEventIds: [2],
    });
    const excursion = event({ id: 2, startedAt: T + 40 * MINUTE_MS, durationMs: 30 * MINUTE_MS });
    expect(verifyScenario('offline-backfill', [offline, excursion], 125).ok).toBe(true);

    const wrong = event({ id: 2, startedAt: T + 40 * MINUTE_MS, durationMs: 29 * MINUTE_MS });
    expect(verifyScenario('offline-backfill', [offline, wrong], 125).detail).toContain(
      '異常持續30分鐘',
    );
  });
});
