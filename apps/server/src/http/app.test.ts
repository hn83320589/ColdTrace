import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MINUTE_MS, type BranchDashboard, type EventDto, type WsMessage } from '@coldtrace/shared';
import { FixedClock } from '../infra/clock';
import { createServices, type Services } from '../services';
import { repeat, seedBasicAssets, series } from '../test/fixtures';
import { createTestDb, T0 } from '../test/helpers';
import { buildApp } from './app';

describe('HTTP API', () => {
  let app: FastifyInstance;
  let services: Services;
  let clock: FixedClock;
  let pushed: WsMessage[];

  beforeEach(async () => {
    const db = createTestDb();
    seedBasicAssets(db);
    clock = new FixedClock(T0);
    services = createServices(db, clock);
    pushed = [];
    services.bus.subscribe((m) => pushed.push(m));
    app = await buildApp(services);
  });

  afterEach(() => app.close());

  const upload = (readings: unknown[]) =>
    app.inject({ method: 'POST', url: '/api/readings/batch', payload: { readings } });

  it('批次上傳回傳接收結果，格式錯誤回 400', async () => {
    const ok = await upload(series('TM-01', T0 - 2 * MINUTE_MS, [4.5, 4.6]));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ accepted: 2, duplicated: 0, rejectedCount: 0 });

    const bad = await upload([{ deviceId: 'TM-01', seq: 'x' }]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
  });

  it('異常成立後推播通知與冷藏櫃狀態，儀表板顯示異常', async () => {
    clock.set(T0 + 20 * MINUTE_MS);
    await upload(series('TM-01', T0, repeat(9.5, 12)));

    const types = pushed.map((m) => m.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'series.appended',
        'event.updated',
        'notification.created',
        'cabinet.status',
      ]),
    );
    const dashboard = (await app.inject('/api/dashboard')).json<BranchDashboard[]>();
    expect(dashboard[0]?.cabinets[0]).toMatchObject({
      cabinetId: 'C01',
      status: 'ALERT',
      currentTempX10: 95,
    });
  });

  it('處置紀錄：驗證報廢數量，成功後可在事件詳情看到', async () => {
    clock.set(T0 + 30 * MINUTE_MS);
    await upload(series('TM-01', T0, [...repeat(9.5, 12), 5]));
    const [event] = (await app.inject('/api/events?type=EXCURSION')).json<EventDto[]>();

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/events/${event!.id}/dispositions`,
      payload: { handler: '王護理師', note: '移櫃', vaccineDiscarded: true, discardedQty: 0 },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: `/api/events/${event!.id}/dispositions`,
      payload: { handler: '王護理師', note: '移櫃並報廢', vaccineDiscarded: true, discardedQty: 5 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ dispositions: unknown[] }>().dispositions).toHaveLength(1);
  });

  it('更換溫度計 API：新舊裝置資料歸屬同一冷藏櫃', async () => {
    await app.inject({ method: 'POST', url: '/api/devices', payload: { id: 'TM-NEW' } });
    clock.set(T0 + 10 * MINUTE_MS);
    await upload(series('TM-01', T0, repeat(4.5, 5)));

    const swap = await app.inject({
      method: 'POST',
      url: '/api/cabinets/C01/device-replacement',
      payload: { newDeviceId: 'TM-NEW', at: new Date(T0 + 6 * MINUTE_MS).toISOString() },
    });
    expect(swap.statusCode).toBe(200);

    // 舊裝置延遲補傳更換前的資料、新裝置上傳更換後的資料
    await upload([
      ...series('TM-01', T0 + 5 * MINUTE_MS, [4.4], 6),
      ...series('TM-NEW', T0 + 6 * MINUTE_MS, [4.3, 4.2]),
    ]);
    const { points } = (
      await app.inject(`/api/cabinets/C01/readings?from=${T0}&to=${T0 + 10 * MINUTE_MS}`)
    ).json<{
      points: [number, number][];
    }>();
    expect(points.map(([, v]) => v)).toEqual([45, 45, 45, 45, 45, 44, 43, 42]);
  });

  it('未知路徑與不存在的事件回 404', async () => {
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
    expect((await app.inject('/api/events/999')).statusCode).toBe(404);
  });
});
