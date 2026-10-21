import type { NotificationDto, NotificationKind } from '@coldtrace/shared';
import { all, get, run, type Db } from '../../infra/db';

interface NotificationRow {
  id: number;
  event_id: number;
  cabinet_id: string;
  kind: NotificationKind;
  message: string;
  created_at: number;
}

const toDto = (r: NotificationRow): NotificationDto => ({
  id: r.id,
  eventId: r.event_id,
  cabinetId: r.cabinet_id,
  kind: r.kind,
  message: r.message,
  createdAt: r.created_at,
});

const SELECT_SQL = `
  SELECT n.id, n.event_id, e.cabinet_id, n.kind, n.message, n.created_at
  FROM notifications n JOIN events e ON e.id = n.event_id`;

export class NotificationService {
  constructor(private readonly db: Db) {}

  /**
   * 同一事件的同一種通知只會成功寫入一次（UNIQUE(event_id, kind)）。
   * 回傳 null 表示已發過，呼叫端不應再推播。
   */
  notify(
    eventId: number,
    kind: NotificationKind,
    message: string,
    now: number,
  ): NotificationDto | null {
    const { changes, lastId } = run(
      this.db,
      `INSERT OR IGNORE INTO notifications (event_id, kind, message, created_at) VALUES (?, ?, ?, ?)`,
      [eventId, kind, message, now],
    );
    if (changes === 0) return null;
    const row = get<NotificationRow>(this.db, `${SELECT_SQL} WHERE n.id = ?`, [lastId]);
    if (!row) throw new Error(`剛寫入的通知 ${lastId} 讀不到`);
    return toDto(row);
  }

  list(limit = 50): NotificationDto[] {
    return all<NotificationRow>(this.db, `${SELECT_SQL} ORDER BY n.id DESC LIMIT ?`, [limit]).map(
      toDto,
    );
  }

  countFor(eventId: number, kind: NotificationKind): number {
    return (
      get<{ n: number }>(
        this.db,
        'SELECT COUNT(*) AS n FROM notifications WHERE event_id = ? AND kind = ?',
        [eventId, kind],
      )?.n ?? 0
    );
  }
}
