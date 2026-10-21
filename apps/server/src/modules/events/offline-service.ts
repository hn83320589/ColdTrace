import {
  OFFLINE_THRESHOLD_MS,
  SAMPLE_INTERVAL_MS,
  formatTaipei,
  type OfflineStatus,
  type WsMessage,
} from '@coldtrace/shared';
import { all, get, run, transaction, type Db } from '../../infra/db';
import type { AssetService } from '../assets/asset-service';
import type { AfterIngestHook } from '../ingestion/reading-pipeline';
import type { TimeRange } from '../ingestion/ingestion-service';
import type { NotificationService } from '../notifications/notification-service';
import { isFullyCovered } from './coverage';
import type { EventRepository, EventRow } from './event-repository';

/**
 * 斷線事件：
 * - scan()：定期檢查，冷藏櫃超過 15 分鐘沒有資料就成立事件（伺服器重啟後從啟動時間重新起算）
 * - afterIngest()：資料寫入後，判斷是否已恢復、補傳是否補齊、期間是否有超標
 */
export class OfflineService implements AfterIngestHook {
  constructor(
    private readonly db: Db,
    private readonly events: EventRepository,
    private readonly notifications: NotificationService,
    private readonly assets: AssetService,
    /** 本服務開始監控的時間；伺服器自己停機的期間不能算成溫度計斷線 */
    private readonly monitoringSince: number,
  ) {}

  scan(now: number): WsMessage[] {
    return transaction(this.db, () => {
      const out: WsMessage[] = [];
      for (const binding of this.assets.activeBindings(now)) {
        const cabinetId = binding.cabinetId;
        if (this.openEvent(cabinetId)) continue;

        // 從未回報的冷藏櫃以綁定開始時間起算；伺服器重啟後至少等 15 分鐘，讓溫度計有時間補傳
        const lastSeen = this.latestMeasuredAt(cabinetId);
        const silentSince = Math.max(lastSeen ?? binding.boundFrom, this.monitoringSince);
        if (now - silentSince <= OFFLINE_THRESHOLD_MS) continue;

        const startedAt = lastSeen === null ? binding.boundFrom : lastSeen + SAMPLE_INTERVAL_MS;
        const { lastId } = run(
          this.db,
          `INSERT INTO events (cabinet_id, type, status, started_at, detected_at)
           VALUES (?, 'OFFLINE', 'OPEN', ?, ?)`,
          [cabinetId, startedAt, now],
        );
        const message = `${this.assets.cabinetLabel(cabinetId)} 斷線：自 ${formatTaipei(startedAt)} 起未收到量測資料`;
        const notification = this.notifications.notify(lastId, 'OFFLINE_STARTED', message, now);
        if (notification) out.push({ type: 'notification.created', notification });
        this.publish(lastId, now, out);
      }
      return out;
    });
  }

  afterIngest(cabinetId: string, range: TimeRange, now: number, out: WsMessage[]): void {
    const toAssess = new Set<number>();

    const open = this.openEvent(cabinetId);
    const latest = this.latestMeasuredAt(cabinetId);
    if (open && latest !== null && now - latest <= OFFLINE_THRESHOLD_MS) {
      run(this.db, 'UPDATE events SET ended_at = ? WHERE id = ?', [latest, open.id]);
      toAssess.add(open.id);
    }

    const overlapping = all<{ id: number }>(
      this.db,
      `SELECT id FROM events
       WHERE cabinet_id = ? AND type = 'OFFLINE' AND ended_at IS NOT NULL
         AND started_at <= ? AND ended_at > ?`,
      [cabinetId, range.to, range.from],
    );
    for (const { id } of overlapping) toAssess.add(id);

    for (const id of toAssess) {
      const event = this.events.findById(id);
      if (event) this.assess(event, now, out);
    }
  }

  /** 依斷線期間的資料，判定「已補齊正常 / 有超標 / 仍不完整」並建立關聯 */
  private assess(event: EventRow, now: number, out: WsMessage[]): void {
    const from = event.started_at;
    const to = event.ended_at ?? now;

    const excursions = this.events.findExcursionsOverlapping(event.cabinet_id, from, to - 1);
    let linked = 0;
    for (const excursion of excursions) {
      linked += run(
        this.db,
        'INSERT OR IGNORE INTO event_links (offline_event_id, excursion_event_id) VALUES (?, ?)',
        [event.id, excursion.id],
      ).changes;
    }

    const times = all<{ t: number }>(
      this.db,
      `SELECT measured_at AS t FROM readings
       WHERE cabinet_id = ? AND measured_at >= ? AND measured_at < ? ORDER BY measured_at`,
      [event.cabinet_id, from - SAMPLE_INTERVAL_MS, to],
    ).map((r) => r.t);

    const status: OfflineStatus =
      excursions.length > 0
        ? 'BACKFILLED_EXCURSION'
        : isFullyCovered(times, from, to)
          ? 'BACKFILLED_NORMAL'
          : 'INCOMPLETE';

    const { changes } = run(this.db, 'UPDATE events SET status = ? WHERE id = ? AND status != ?', [
      status,
      event.id,
      status,
    ]);
    if (changes > 0 || linked > 0) {
      this.publish(event.id, now, out);
      for (const excursion of excursions) this.publish(excursion.id, now, out);
    }
  }

  private openEvent(cabinetId: string): EventRow | undefined {
    return get<EventRow>(
      this.db,
      `SELECT * FROM events WHERE cabinet_id = ? AND type = 'OFFLINE' AND status = 'OPEN'`,
      [cabinetId],
    );
  }

  private latestMeasuredAt(cabinetId: string): number | null {
    return (
      get<{ t: number | null }>(
        this.db,
        'SELECT MAX(measured_at) AS t FROM readings WHERE cabinet_id = ?',
        [cabinetId],
      )?.t ?? null
    );
  }

  private publish(eventId: number, now: number, out: WsMessage[]): void {
    const row = this.events.findById(eventId);
    if (row) out.push({ type: 'event.updated', event: this.events.toDto(row, now) });
  }
}
