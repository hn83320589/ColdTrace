import type {
  DispositionInput,
  EventDetailDto,
  EventDto,
  EventType,
  WsMessage,
} from '@coldtrace/shared';
import { all, run, transaction, type Db, type Params } from '../../infra/db';
import { NotFoundError } from '../../infra/errors';
import type { EventRepository, EventRow } from './event-repository';

export interface EventFilter {
  type?: EventType | undefined;
  status?: string | undefined;
  cabinetId?: string | undefined;
  /** 與 [from, to] 重疊的事件 */
  from?: number | undefined;
  to?: number | undefined;
  includeMerged?: boolean | undefined;
  limit?: number | undefined;
}

export class EventQueryService {
  constructor(
    private readonly db: Db,
    private readonly events: EventRepository,
  ) {}

  list(filter: EventFilter, now: number): EventDto[] {
    return this.rows(filter).map((row) => this.events.toDto(row, now));
  }

  rows(filter: EventFilter): EventRow[] {
    const where: string[] = [];
    const params: Params = [];
    if (filter.type) {
      where.push('type = ?');
      params.push(filter.type);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    } else if (!filter.includeMerged) {
      where.push(`status != 'MERGED'`);
    }
    if (filter.cabinetId) {
      where.push('cabinet_id = ?');
      params.push(filter.cabinetId);
    }
    if (filter.to !== undefined) {
      where.push('started_at <= ?');
      params.push(filter.to);
    }
    if (filter.from !== undefined) {
      where.push('COALESCE(ended_at, 9e18) >= ?');
      params.push(filter.from);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(filter.limit ?? 500);
    return all<EventRow>(
      this.db,
      `SELECT * FROM events ${clause} ORDER BY started_at DESC, id DESC LIMIT ?`,
      params,
    );
  }

  detail(id: number, now: number): EventDetailDto {
    const row = this.events.findById(id);
    if (!row) throw new NotFoundError('事件', id);
    return this.events.toDetailDto(row, now);
  }

  /** 處置紀錄只增不改，保留完整稽核軌跡 */
  addDisposition(
    eventId: number,
    input: DispositionInput,
    now: number,
  ): { detail: EventDetailDto; messages: WsMessage[] } {
    return transaction(this.db, () => {
      const row = this.events.findById(eventId);
      if (!row) throw new NotFoundError('事件', eventId);
      run(
        this.db,
        `INSERT INTO dispositions (event_id, handler, note, vaccine_discarded, discarded_qty, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          input.handler,
          input.note,
          input.vaccineDiscarded ? 1 : 0,
          input.discardedQty,
          now,
        ],
      );
      const detail = this.events.toDetailDto(row, now);
      return { detail, messages: [{ type: 'event.updated', event: detail }] };
    });
  }
}
