import type {
  DispositionDto,
  EventDetailDto,
  EventDto,
  EventType,
  ExcursionStatus,
  OfflineStatus,
} from '@coldtrace/shared';
import { all, get, run, type Db } from '../../infra/db';

export interface EventRow {
  id: number;
  cabinet_id: string;
  type: EventType;
  status: ExcursionStatus | OfflineStatus;
  started_at: number;
  ended_at: number | null;
  detected_at: number;
  duration_ms: number | null;
  max_temp_x10: number | null;
  min_temp_x10: number | null;
  degree_minutes_x10: number | null;
  backfilled: number;
  merged_into: number | null;
}

interface DispositionRow {
  id: number;
  event_id: number;
  handler: string;
  note: string;
  vaccine_discarded: number;
  discarded_qty: number;
  created_at: number;
}

export interface ExcursionFields {
  status: ExcursionStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  maxTempX10: number;
  minTempX10: number;
  degreeMinutesX10: number;
}

const toDisposition = (r: DispositionRow): DispositionDto => ({
  id: r.id,
  eventId: r.event_id,
  handler: r.handler,
  note: r.note,
  vaccineDiscarded: r.vaccine_discarded === 1,
  discardedQty: r.discarded_qty,
  createdAt: r.created_at,
});

export class EventRepository {
  constructor(private readonly db: Db) {}

  findById(id: number): EventRow | undefined {
    return get<EventRow>(this.db, 'SELECT * FROM events WHERE id = ?', [id]);
  }

  /** 與 [from, to] 時間重疊、未被合併或撤銷的溫度異常事件 */
  findExcursionsOverlapping(cabinetId: string, from: number, to: number): EventRow[] {
    return all<EventRow>(
      this.db,
      `SELECT * FROM events
       WHERE cabinet_id = ? AND type = 'EXCURSION' AND status NOT IN ('MERGED', 'RETRACTED')
         AND started_at <= ? AND COALESCE(ended_at, 9e18) >= ?
       ORDER BY started_at, id`,
      [cabinetId, to, from],
    );
  }

  insertExcursion(
    cabinetId: string,
    f: ExcursionFields,
    detectedAt: number,
    backfilled: boolean,
  ): number {
    return run(
      this.db,
      `INSERT INTO events (cabinet_id, type, status, started_at, ended_at, detected_at,
         duration_ms, max_temp_x10, min_temp_x10, degree_minutes_x10, backfilled)
       VALUES (?, 'EXCURSION', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cabinetId,
        f.status,
        f.startedAt,
        f.endedAt,
        detectedAt,
        f.durationMs,
        f.maxTempX10,
        f.minTempX10,
        f.degreeMinutesX10,
        backfilled ? 1 : 0,
      ],
    ).lastId;
  }

  /** 回傳是否有欄位實際改變 */
  updateExcursion(id: number, f: ExcursionFields): boolean {
    return (
      run(
        this.db,
        `UPDATE events SET status = ?, started_at = ?, ended_at = ?, duration_ms = ?,
           max_temp_x10 = ?, min_temp_x10 = ?, degree_minutes_x10 = ?
         WHERE id = ? AND NOT (status IS ? AND started_at IS ? AND ended_at IS ? AND duration_ms IS ?
           AND max_temp_x10 IS ? AND min_temp_x10 IS ? AND degree_minutes_x10 IS ?)`,
        [
          f.status,
          f.startedAt,
          f.endedAt,
          f.durationMs,
          f.maxTempX10,
          f.minTempX10,
          f.degreeMinutesX10,
          id,
          f.status,
          f.startedAt,
          f.endedAt,
          f.durationMs,
          f.maxTempX10,
          f.minTempX10,
          f.degreeMinutesX10,
        ],
      ).changes > 0
    );
  }

  /** 把 mergedId 併入 primaryId，並把關聯的斷線事件轉移過去 */
  mergeExcursion(mergedId: number, primaryId: number): void {
    run(this.db, `UPDATE events SET status = 'MERGED', merged_into = ? WHERE id = ?`, [
      primaryId,
      mergedId,
    ]);
    run(
      this.db,
      `INSERT OR IGNORE INTO event_links (offline_event_id, excursion_event_id)
       SELECT offline_event_id, ? FROM event_links WHERE excursion_event_id = ?`,
      [primaryId, mergedId],
    );
    run(this.db, 'DELETE FROM event_links WHERE excursion_event_id = ?', [mergedId]);
  }

  /** 撤銷溫度異常事件並解除與斷線事件的關聯（斷線事件會在 afterIngest 重新判定） */
  retractExcursion(id: number): void {
    run(this.db, `UPDATE events SET status = 'RETRACTED' WHERE id = ?`, [id]);
    run(this.db, 'DELETE FROM event_links WHERE excursion_event_id = ?', [id]);
  }

  linkedEventIds(row: EventRow): number[] {
    const sql =
      row.type === 'OFFLINE'
        ? 'SELECT excursion_event_id AS id FROM event_links WHERE offline_event_id = ? ORDER BY 1'
        : 'SELECT offline_event_id AS id FROM event_links WHERE excursion_event_id = ? ORDER BY 1';
    return all<{ id: number }>(this.db, sql, [row.id]).map((r) => r.id);
  }

  dispositions(eventId: number): DispositionDto[] {
    return all<DispositionRow>(
      this.db,
      'SELECT * FROM dispositions WHERE event_id = ? ORDER BY created_at DESC, id DESC',
      [eventId],
    ).map(toDisposition);
  }

  toDto(row: EventRow, now: number): EventDto {
    const durationMs =
      row.type === 'EXCURSION' ? row.duration_ms : (row.ended_at ?? now) - row.started_at;
    return {
      id: row.id,
      cabinetId: row.cabinet_id,
      type: row.type,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      detectedAt: row.detected_at,
      durationMs,
      maxTempX10: row.max_temp_x10,
      minTempX10: row.min_temp_x10,
      degreeMinutesX10: row.degree_minutes_x10,
      backfilled: row.backfilled === 1,
      linkedEventIds: this.linkedEventIds(row),
      latestDisposition: this.dispositions(row.id)[0] ?? null,
    };
  }

  toDetailDto(row: EventRow, now: number): EventDetailDto {
    return { ...this.toDto(row, now), dispositions: this.dispositions(row.id) };
  }
}
