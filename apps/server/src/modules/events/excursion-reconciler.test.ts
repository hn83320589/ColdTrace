import { beforeEach, describe, expect, it } from 'vitest';
import { MINUTE_MS } from '@coldtrace/shared';
import { all } from '../../infra/db';
import { createTestContext } from '../../test/context';
import { repeat, series } from '../../test/fixtures';
import { T0 } from '../../test/helpers';
import type { EventRow } from './event-repository';

const at = (minute: number) => T0 + minute * MINUTE_MS;

describe('ExcursionReconciler（經由 ReadingPipeline）', () => {
  let ctx: ReturnType<typeof createTestContext>;
  const excursions = () =>
    all<EventRow>(ctx.db, `SELECT * FROM events WHERE type = 'EXCURSION' ORDER BY id`);
  const notificationKinds = () =>
    ctx.notifications
      .list(100)
      .map((n) => n.kind)
      .sort();

  /** 模擬即時上傳：每分鐘一筆，時鐘跟著前進 */
  function sendRealtime(temps: number[], startMinute: number, firstSeq: number) {
    series('TM-01', at(startMinute), temps, firstSeq).forEach((reading, i) => {
      ctx.clock.set(at(startMinute + i) + 5_000);
      ctx.pipeline.process([reading]);
    });
  }

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('即時資料：第 10 分鐘成立、回到範圍時結束，各一則通知', () => {
    sendRealtime([5, ...repeat(9, 9)], 0, 1);
    expect(excursions()).toHaveLength(0);

    sendRealtime([9], 10, 11);
    expect(excursions()).toMatchObject([{ status: 'OPEN', started_at: at(1), backfilled: 0 }]);

    sendRealtime([5], 11, 12);
    expect(excursions()).toMatchObject([
      { status: 'CLOSED', ended_at: at(11), duration_ms: 10 * MINUTE_MS },
    ]);
    expect(notificationKinds()).toEqual(['EXCURSION_ENDED', 'EXCURSION_STARTED']);
  });

  it('超標 9 分鐘後回到範圍，不產生事件也不發通知', () => {
    sendRealtime([5, ...repeat(9, 9), 5], 0, 1);
    expect(excursions()).toHaveLength(0);
    expect(notificationKinds()).toEqual([]);
  });

  it('同一批資料不論重送幾次，「事件成立」通知只有一則', () => {
    ctx.clock.set(at(30));
    const batch = series('TM-01', at(0), [5, ...repeat(9, 15), 5]);
    for (let i = 0; i < 3; i++) ctx.pipeline.process(batch);
    // 拆成小批、亂序再送一次
    ctx.pipeline.process([...batch].reverse().slice(0, 8));
    ctx.pipeline.process(batch.slice(8));

    expect(excursions()).toHaveLength(1);
    const event = excursions()[0]!;
    expect(ctx.notifications.countFor(event.id, 'EXCURSION_STARTED')).toBe(1);
    expect(ctx.notifications.countFor(event.id, 'EXCURSION_ENDED')).toBe(1);
  });

  it('補傳更早的超標資料，事件往前延長而不是新增', () => {
    ctx.clock.set(at(25));
    ctx.pipeline.process(series('TM-01', at(5), repeat(9, 15), 6));
    const [before] = excursions();
    expect(before?.started_at).toBe(at(5));

    ctx.pipeline.process(series('TM-01', at(0), [5, ...repeat(9, 4)], 1));
    expect(excursions()).toMatchObject([
      { id: before?.id, started_at: at(1), duration_ms: 19 * MINUTE_MS },
    ]);
  });

  it('補傳填滿兩段之間的缺口，兩個事件合併為一個', () => {
    ctx.clock.set(at(60));
    ctx.pipeline.process(series('TM-01', at(0), repeat(9, 12), 1)); // 0–11
    ctx.pipeline.process(series('TM-01', at(20), [...repeat(9, 12), 5], 21)); // 20–31，32 恢復
    expect(excursions()).toHaveLength(2);

    ctx.pipeline.process(series('TM-01', at(12), repeat(9, 8), 13)); // 補 12–19
    const rows = excursions();
    expect(rows.map((r) => r.status)).toEqual(['CLOSED', 'MERGED']);
    expect(rows[0]).toMatchObject({
      started_at: at(0),
      ended_at: at(32),
      duration_ms: 32 * MINUTE_MS,
    });
    expect(rows[1]?.merged_into).toBe(rows[0]?.id);
  });

  it('補傳出已結束的歷史事件：標記為補傳，成立與結束通知各一則', () => {
    ctx.clock.set(at(180));
    ctx.pipeline.process(series('TM-01', at(0), [5, ...repeat(10, 30), 5]));

    expect(excursions()).toMatchObject([
      { status: 'CLOSED', backfilled: 1, degree_minutes_x10: 600 },
    ]);
    expect(notificationKinds()).toEqual(['EXCURSION_ENDED', 'EXCURSION_STARTED']);
    expect(ctx.notifications.list()[1]?.message).toContain('依補傳資料判定');
  });

  it('其他冷藏櫃的資料不影響本櫃事件', () => {
    ctx.clock.set(at(30));
    ctx.pipeline.process([
      ...series('TM-01', at(0), repeat(9, 12), 1),
      ...series('TM-02', at(0), repeat(5, 12), 1),
    ]);
    expect(excursions().map((e) => e.cabinet_id)).toEqual(['C01']);
  });
  it('同一時間點換流水號重送，累積超標度分鐘與持續時間不變', () => {
    ctx.clock.set(at(20));
    // 1 分鐘正常 + 12 分鐘 9.0°C + 1 分鐘正常，共 14 個時間點
    const temps = [5, ...repeat(9, 12), 5];
    ctx.pipeline.process(series('TM-01', at(0), temps, 1));
    const [before] = excursions();
    expect(before).toMatchObject({ degree_minutes_x10: 120, duration_ms: 12 * MINUTE_MS });

    const result = ctx.pipeline.process(series('TM-01', at(0), temps, 1001));
    expect(result.response).toMatchObject({ accepted: 0, duplicated: 14 });
    expect(excursions()).toMatchObject([
      { id: before!.id, degree_minutes_x10: 120, duration_ms: 12 * MINUTE_MS },
    ]);
  });
});
