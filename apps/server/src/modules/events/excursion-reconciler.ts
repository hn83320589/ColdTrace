import {
  EXCURSION_MIN_DURATION_MS,
  OFFLINE_THRESHOLD_MS,
  SAMPLE_INTERVAL_MS,
  TEMP_MAX_X10,
  TEMP_MIN_X10,
  formatTaipei,
  fromX10,
  type WsMessage,
} from '@coldtrace/shared';
import { all, get, type Db } from '../../infra/db';
import type { AssetService } from '../assets/asset-service';
import type { TimeRange } from '../ingestion/ingestion-service';
import type { NotificationService } from '../notifications/notification-service';
import { detectExcursionRuns, type ExcursionRun, type Sample } from './excursion-detector';
import type { EventRepository, EventRow, ExcursionFields } from './event-repository';

const IN_RANGE_SQL = `temp_x10 BETWEEN ${TEMP_MIN_X10} AND ${TEMP_MAX_X10}`;

function fieldsOf(run: ExcursionRun): ExcursionFields {
  return {
    status: run.end === null ? 'OPEN' : 'CLOSED',
    startedAt: run.start,
    endedAt: run.end,
    durationMs: run.durationMs,
    maxTempX10: run.maxTempX10,
    minTempX10: run.minTempX10,
    degreeMinutesX10: run.degreeMinutesX10,
  };
}

/**
 * 把「量測序列的判定結果」對帳進資料庫。
 * 重算視窗前後各延伸到最近一筆正常讀值：只有視窗內的連續段可能因新資料而改變。
 */
export class ExcursionReconciler {
  constructor(
    private readonly db: Db,
    private readonly events: EventRepository,
    private readonly notifications: NotificationService,
    private readonly assets: AssetService,
  ) {}

  reconcile(cabinetId: string, range: TimeRange, now: number, out: WsMessage[]): void {
    const windowFrom =
      get<{ t: number | null }>(
        this.db,
        `SELECT MAX(measured_at) AS t FROM readings
         WHERE cabinet_id = ? AND measured_at < ? AND ${IN_RANGE_SQL}`,
        [cabinetId, range.from],
      )?.t ?? 0;
    const windowTo =
      get<{ t: number | null }>(
        this.db,
        `SELECT MIN(measured_at) AS t FROM readings
         WHERE cabinet_id = ? AND measured_at > ? AND ${IN_RANGE_SQL}`,
        [cabinetId, range.to],
      )?.t ?? Number.MAX_SAFE_INTEGER;

    const samples = all<Sample>(
      this.db,
      `SELECT measured_at AS t, temp_x10 AS tempX10 FROM readings
       WHERE cabinet_id = ? AND measured_at BETWEEN ? AND ? ORDER BY measured_at`,
      [cabinetId, windowFrom, windowTo],
    );
    const runs = detectExcursionRuns(samples).filter((r) => r.established);
    const existing = this.events.findExcursionsOverlapping(cabinetId, windowFrom, windowTo);

    // ① 既有事件的開始時間一定是一筆超標讀值，因此恰好屬於一個連續段
    const matchesByRun = runs.map((run) =>
      existing.filter((e) => e.started_at >= run.start && e.started_at <= run.lastOutAt),
    );

    // ② 開始時間落在視窗內、卻不屬於任何成立連續段的事件：補傳的正常讀值把它切短了。
    //    與尚無事件的成立段重疊就由該段承接（保留事件、處置與已發通知），否則撤銷
    const claimed = new Set(matchesByRun.flat().map((e) => e.id));
    const orphans = existing.filter(
      (e) => !claimed.has(e.id) && e.started_at >= windowFrom && e.started_at <= windowTo,
    );
    runs.forEach((run, i) => {
      if (matchesByRun[i]!.length > 0) return;
      const index = orphans.findIndex(
        (e) =>
          e.started_at <= run.lastOutAt && (e.ended_at ?? Number.MAX_SAFE_INTEGER) >= run.start,
      );
      if (index >= 0) matchesByRun[i] = orphans.splice(index, 1);
    });

    runs.forEach((run, i) => this.apply(cabinetId, run, matchesByRun[i]!, now, out));
    for (const orphan of orphans) this.retract(cabinetId, orphan, now, out);
  }

  /** 資料顯示這段超標其實不足 10 分鐘：保留紀錄供稽核，標記為已撤銷並通知 */
  private retract(cabinetId: string, event: EventRow, now: number, out: WsMessage[]): void {
    this.events.retractExcursion(event.id);
    this.notify(event.id, 'EXCURSION_RETRACTED', this.retractedMessage(cabinetId, event), now, out);
    this.publish(event.id, now, out);
  }

  private apply(
    cabinetId: string,
    run: ExcursionRun,
    matches: EventRow[],
    now: number,
    out: WsMessage[],
  ): void {
    const fields = fieldsOf(run);
    const [primary, ...merged] = matches;
    let eventId: number;

    if (!primary) {
      const establishedAt = run.start + EXCURSION_MIN_DURATION_MS - SAMPLE_INTERVAL_MS;
      const backfilled = now - establishedAt > OFFLINE_THRESHOLD_MS;
      eventId = this.events.insertExcursion(cabinetId, fields, now, backfilled);
      this.notify(
        eventId,
        'EXCURSION_STARTED',
        this.startedMessage(cabinetId, run, backfilled),
        now,
        out,
      );
    } else {
      eventId = primary.id;
      const changed = this.events.updateExcursion(eventId, fields);
      for (const m of merged) this.events.mergeExcursion(m.id, eventId);
      if (!changed && merged.length === 0) return;
    }

    if (run.end !== null) {
      this.notify(eventId, 'EXCURSION_ENDED', this.endedMessage(cabinetId, run), now, out);
    }
    this.publish(eventId, now, out);
    for (const m of merged) this.publish(m.id, now, out);
  }

  private notify(
    eventId: number,
    kind: 'EXCURSION_STARTED' | 'EXCURSION_ENDED' | 'EXCURSION_RETRACTED',
    message: string,
    now: number,
    out: WsMessage[],
  ): void {
    const notification = this.notifications.notify(eventId, kind, message, now);
    if (notification) out.push({ type: 'notification.created', notification });
  }

  private publish(eventId: number, now: number, out: WsMessage[]): void {
    const row = this.events.findById(eventId);
    if (row) out.push({ type: 'event.updated', event: this.events.toDto(row, now) });
  }

  private startedMessage(cabinetId: string, run: ExcursionRun, backfilled: boolean): string {
    const extreme =
      run.maxTempX10 > TEMP_MAX_X10
        ? `最高 ${fromX10(run.maxTempX10)}°C`
        : `最低 ${fromX10(run.minTempX10)}°C`;
    const source = backfilled ? '（依補傳資料判定）' : '';
    return `${this.assets.cabinetLabel(cabinetId)} 溫度異常事件成立${source}：自 ${formatTaipei(run.start)} 起超出 2–8°C，${extreme}`;
  }

  private endedMessage(cabinetId: string, run: ExcursionRun): string {
    const minutes = Math.round(run.durationMs / 60_000);
    return `${this.assets.cabinetLabel(cabinetId)} 溫度異常事件結束：持續 ${minutes} 分鐘，累積超標 ${fromX10(run.degreeMinutesX10)} 度分鐘`;
  }

  private retractedMessage(cabinetId: string, event: EventRow): string {
    return `${this.assets.cabinetLabel(cabinetId)} 溫度異常事件撤銷：補傳資料顯示自 ${formatTaipei(event.started_at)} 起的超標未連續達 10 分鐘`;
  }
}
