import { beforeEach, describe, expect, it } from 'vitest';
import { MINUTE_MS, SECOND_MS } from '@coldtrace/shared';
import { all } from '../../infra/db';
import { createTestContext } from '../../test/context';
import { repeat, series } from '../../test/fixtures';
import { T0 } from '../../test/helpers';
import type { EventRow } from './event-repository';
import { OfflineService } from './offline-service';

const at = (minute: number) => T0 + minute * MINUTE_MS;

describe('OfflineService', () => {
  let ctx: ReturnType<typeof createTestContext>;
  const eventsOf = (type: 'OFFLINE' | 'EXCURSION') =>
    all<EventRow>(
      ctx.db,
      `SELECT * FROM events WHERE type = ? AND cabinet_id = 'C01' ORDER BY id`,
      [type],
    );
  const links = () => all(ctx.db, 'SELECT * FROM event_links');

  /** C01 在第 0–9 分鐘正常回報，C02 一直正常回報（不應被判斷線） */
  beforeEach(() => {
    ctx = createTestContext();
    ctx.clock.set(at(10));
    ctx.pipeline.process(series('TM-01', at(0), repeat(4.5, 10), 1));
  });

  function keepC02Alive(untilMinute: number) {
    ctx.clock.set(at(untilMinute));
    ctx.pipeline.process(series('TM-02', at(untilMinute - 1), [4.5], untilMinute));
  }

  it('最後一筆資料後滿 15 分鐘不觸發，超過 15 分鐘才成立斷線事件', () => {
    keepC02Alive(24);
    ctx.clock.set(at(9) + 15 * MINUTE_MS); // 最後一筆在第 9 分鐘
    ctx.offline.scan(ctx.clock.now());
    expect(eventsOf('OFFLINE')).toHaveLength(0);

    ctx.clock.advance(30 * SECOND_MS);
    const messages = ctx.offline.scan(ctx.clock.now());
    expect(eventsOf('OFFLINE')).toMatchObject([{ status: 'OPEN', started_at: at(10) }]);
    expect(messages.map((m) => m.type)).toContain('notification.created');
  });

  it('伺服器自己停機後重啟：從啟動時間起算 15 分鐘，給溫度計補傳的機會', () => {
    // 最後一筆在第 9 分鐘，伺服器停機到第 120 分鐘才重啟
    const restarted = new OfflineService(
      ctx.db,
      ctx.events,
      ctx.notifications,
      ctx.assets,
      at(120),
    );
    restarted.scan(at(121));
    restarted.scan(at(135));
    expect(eventsOf('OFFLINE')).toHaveLength(0);

    // 重啟後溫度計補傳了停機期間的資料 → 不需要斷線事件
    ctx.clock.set(at(130));
    ctx.pipeline.process(series('TM-01', at(10), repeat(4.5, 120), 11));
    restarted.scan(at(140));
    expect(eventsOf('OFFLINE')).toHaveLength(0);
  });

  it('伺服器重啟後超過 15 分鐘仍沒有資料，才成立斷線事件，起點仍是資料中斷的時間', () => {
    const restarted = new OfflineService(
      ctx.db,
      ctx.events,
      ctx.notifications,
      ctx.assets,
      at(120),
    );
    restarted.scan(at(135) + SECOND_MS);
    expect(eventsOf('OFFLINE')).toMatchObject([{ status: 'OPEN', started_at: at(10) }]);
  });

  it('重複掃描只會有一個斷線事件與一則通知', () => {
    for (let i = 0; i < 5; i++) {
      ctx.clock.set(at(30 + i));
      ctx.offline.scan(ctx.clock.now());
    }
    const [event] = eventsOf('OFFLINE');
    expect(eventsOf('OFFLINE')).toHaveLength(1);
    expect(ctx.notifications.countFor(event!.id, 'OFFLINE_STARTED')).toBe(1);
  });

  it('從未回報的冷藏櫃，自綁定起超過 15 分鐘才判斷線', () => {
    ctx.assets.createCabinet({ id: 'C03', branchId: 'B01', name: '新櫃' });
    ctx.assets.createDevice({ id: 'TM-03' }, T0);
    ctx.assets.bindDevice('TM-03', 'C03', at(100));
    const offlineOfC03 = () =>
      all<EventRow>(ctx.db, `SELECT * FROM events WHERE cabinet_id = 'C03'`);

    ctx.offline.scan(at(115));
    expect(offlineOfC03()).toHaveLength(0);
    ctx.offline.scan(at(115) + SECOND_MS);
    expect(offlineOfC03()).toMatchObject([{ type: 'OFFLINE', started_at: at(100) }]);
  });

  it('沒有綁定中裝置的冷藏櫃不判斷線', () => {
    ctx.assets.createCabinet({ id: 'C03', branchId: 'B01', name: '未啟用' });
    ctx.clock.set(at(60));
    ctx.offline.scan(ctx.clock.now());
    expect(all(ctx.db, `SELECT * FROM events WHERE cabinet_id = 'C03'`)).toHaveLength(0);
  });

  describe('恢復連線後的補傳判定（斷線 2 小時）', () => {
    beforeEach(() => {
      ctx.clock.set(at(30));
      ctx.offline.scan(ctx.clock.now()); // 自第 10 分鐘起斷線
      ctx.clock.set(at(130) + 10 * SECOND_MS);
    });

    it('補傳資料全部正常 → 已補齊、溫度正常', () => {
      ctx.pipeline.process(series('TM-01', at(10), repeat(4.5, 121), 11)); // 10–130
      expect(eventsOf('OFFLINE')).toMatchObject([
        { status: 'BACKFILLED_NORMAL', ended_at: at(130) },
      ]);
    });

    it('補傳資料含 30 分鐘超標 → 產生時間正確的異常事件並互相關聯', () => {
      const temps = [...repeat(4.5, 40), ...repeat(9.5, 30), ...repeat(4.5, 51)]; // 50–79 超標
      ctx.pipeline.process(series('TM-01', at(10), temps, 11));

      const [excursion] = eventsOf('EXCURSION');
      expect(excursion).toMatchObject({
        status: 'CLOSED',
        started_at: at(50),
        ended_at: at(80),
        duration_ms: 30 * MINUTE_MS,
        backfilled: 1,
      });
      const [offline] = eventsOf('OFFLINE');
      expect(offline?.status).toBe('BACKFILLED_EXCURSION');
      expect(links()).toEqual([
        { offline_event_id: offline?.id, excursion_event_id: excursion?.id },
      ]);
      expect(ctx.events.toDto(excursion!, ctx.clock.now()).linkedEventIds).toEqual([offline?.id]);
    });

    it('只送即時資料 → 資料不完整；之後補傳完成 → 已補齊', () => {
      ctx.pipeline.process(series('TM-01', at(130), [4.5], 131));
      expect(eventsOf('OFFLINE')).toMatchObject([{ status: 'INCOMPLETE', ended_at: at(130) }]);

      ctx.pipeline.process(series('TM-01', at(10), repeat(4.5, 120), 11));
      expect(eventsOf('OFFLINE')[0]?.status).toBe('BACKFILLED_NORMAL');
    });

    it('補傳的超標事件之後被撤銷 → 解除關聯，斷線事件改判為已補齊、溫度正常', () => {
      // 第 50–55、57–62 分鐘超標，第 56 分鐘缺資料 → 13 分鐘異常事件
      ctx.pipeline.process([
        ...series('TM-01', at(10), [...repeat(4.5, 40), ...repeat(9.5, 6)], 11), // 10–55
        ...series('TM-01', at(57), [...repeat(9.5, 6), ...repeat(4.5, 68)], 200), // 57–130
      ]);
      expect(eventsOf('OFFLINE')[0]?.status).toBe('BACKFILLED_EXCURSION');
      expect(links()).toHaveLength(1);

      ctx.pipeline.process(series('TM-01', at(56), [4.5], 500));

      expect(eventsOf('EXCURSION')).toMatchObject([{ status: 'RETRACTED' }]);
      expect(links()).toEqual([]);
      expect(eventsOf('OFFLINE')[0]?.status).toBe('BACKFILLED_NORMAL');
    });

    it('補傳順序（新到舊、分批）不影響最終結果', () => {
      const temps = [...repeat(4.5, 40), ...repeat(9.5, 30), ...repeat(4.5, 51)];
      const readings = series('TM-01', at(10), temps, 11);
      const batches = [readings.slice(100), readings.slice(50, 100), readings.slice(0, 50)];
      for (const batch of batches) ctx.pipeline.process(batch);

      expect(eventsOf('OFFLINE')[0]?.status).toBe('BACKFILLED_EXCURSION');
      expect(eventsOf('EXCURSION')).toMatchObject([{ started_at: at(50), ended_at: at(80) }]);
      expect(links()).toHaveLength(1);
    });
  });
});
