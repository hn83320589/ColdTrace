import type { IngestResponse, ReadingInput, ReadingPoint, WsMessage } from '@coldtrace/shared';
import { get, transaction, type Db } from '../../infra/db';
import type { Clock } from '../../infra/clock';
import type { ExcursionReconciler } from '../events/excursion-reconciler';
import type { IngestionService, IngestResult, TimeRange } from './ingestion-service';

/** 讀值寫入後需要接著執行的處理（例如斷線事件的補傳判定） */
export interface AfterIngestHook {
  afterIngest(cabinetId: string, range: TimeRange, now: number, out: WsMessage[]): void;
}

export interface PipelineResult {
  response: IngestResponse;
  conflicts: IngestResult['conflicts'];
  /** transaction commit 後才可推播 */
  messages: WsMessage[];
}

/**
 * 一個批次 = 一個 transaction：寫入、事件判定、通知全部一起成功或一起回滾。
 * node:sqlite 為同步 API，批次之間天然串行，不會有兩個批次同時判定同一段超標。
 */
export class ReadingPipeline {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ingestion: IngestionService,
    private readonly excursions: ExcursionReconciler,
    private readonly hooks: AfterIngestHook[] = [],
  ) {}

  process(readings: ReadingInput[]): PipelineResult {
    const now = this.clock.now();
    return transaction(this.db, () => {
      const result = this.ingestion.ingest(readings, now);
      const messages: WsMessage[] = [];

      for (const [cabinetId, range] of result.affected) {
        messages.push(this.seriesMessage(cabinetId, range, result));
        this.excursions.reconcile(cabinetId, range, now, messages);
        for (const hook of this.hooks) hook.afterIngest(cabinetId, range, now, messages);
      }
      return { response: result.response, conflicts: result.conflicts, messages };
    });
  }

  /** 純粹往後新增 → 直接附上新點；插入到歷史中間（補傳）→ 通知前端重抓該區段 */
  private seriesMessage(cabinetId: string, range: TimeRange, result: IngestResult): WsMessage {
    const points: ReadingPoint[] = result.inserted
      .filter((r) => r.cabinetId === cabinetId)
      .map((r) => [r.measuredAt, r.tempX10]);
    const total =
      get<{ n: number }>(
        this.db,
        'SELECT COUNT(*) AS n FROM readings WHERE cabinet_id = ? AND measured_at >= ?',
        [cabinetId, range.from],
      )?.n ?? 0;
    if (total === points.length) {
      return { type: 'series.appended', cabinetId, points: points.sort((a, b) => a[0] - b[0]) };
    }
    return { type: 'series.changed', cabinetId, from: range.from, to: range.to };
  }
}
