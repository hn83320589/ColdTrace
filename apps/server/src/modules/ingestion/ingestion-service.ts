import {
  BACKFILL_WINDOW_MS,
  FUTURE_TOLERANCE_MS,
  type IngestResponse,
  type ReadingInput,
  type RejectReason,
  type RejectedReading,
} from '@coldtrace/shared';
import { get, run, type Db } from '../../infra/db';
import type { AssetService } from '../assets/asset-service';

export interface TimeRange {
  from: number;
  to: number;
}

export interface InsertedReading {
  cabinetId: string;
  measuredAt: number;
  tempX10: number;
}

export interface IngestResult {
  response: IngestResponse;
  /** 各冷藏櫃「實際新增」資料的量測時間範圍，作為後續事件重算的依據 */
  affected: Map<string, TimeRange>;
  inserted: InsertedReading[];
  /** 與既有紀錄重複（同流水號或同量測時間）但內容不同的資料（不覆寫，僅回報） */
  conflicts: { deviceId: string; seq: number }[];
}

/** 溫度計合理量測範圍，超出視為感測器異常 */
const PLAUSIBLE_MIN_X10 = -400;
const PLAUSIBLE_MAX_X10 = 600;

function toOneDecimal(temperature: number): number | null {
  const x10 = Math.round(temperature * 10);
  if (Math.abs(temperature * 10 - x10) > 1e-6) return null;
  if (x10 < PLAUSIBLE_MIN_X10 || x10 > PLAUSIBLE_MAX_X10) return null;
  return x10;
}

export class IngestionService {
  constructor(
    private readonly db: Db,
    private readonly assets: AssetService,
  ) {}

  /** 呼叫端負責包 transaction，讓寫入與事件判定一起成功或一起失敗 */
  ingest(readings: ReadingInput[], now: number): IngestResult {
    const rejected: RejectedReading[] = [];
    const affected = new Map<string, TimeRange>();
    const inserted: InsertedReading[] = [];
    const conflicts: { deviceId: string; seq: number }[] = [];
    const knownDevices = new Map<string, boolean>();
    let duplicated = 0;

    const reject = (r: ReadingInput, reason: RejectReason) =>
      rejected.push({ deviceId: r.deviceId, seq: r.seq, reason });

    for (const reading of readings) {
      const measuredAt = Date.parse(reading.measuredAt);
      const tempX10 = toOneDecimal(reading.temperature);

      if (tempX10 === null) {
        reject(reading, 'INVALID_TEMPERATURE');
        continue;
      }
      if (measuredAt < now - BACKFILL_WINDOW_MS) {
        reject(reading, 'TOO_OLD');
        continue;
      }
      if (measuredAt > now + FUTURE_TOLERANCE_MS) {
        reject(reading, 'FROM_FUTURE');
        continue;
      }
      if (!knownDevices.has(reading.deviceId)) {
        knownDevices.set(reading.deviceId, this.assets.deviceExists(reading.deviceId));
      }
      if (!knownDevices.get(reading.deviceId)) {
        reject(reading, 'UNKNOWN_DEVICE');
        continue;
      }
      const cabinetId = this.assets.resolveCabinet(reading.deviceId, measuredAt);
      if (cabinetId === null) {
        reject(reading, 'UNBOUND');
        continue;
      }

      const { changes } = run(
        this.db,
        `INSERT OR IGNORE INTO readings
           (device_id, seq, cabinet_id, measured_at, temp_x10, battery, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [reading.deviceId, reading.seq, cabinetId, measuredAt, tempX10, reading.battery, now],
      );

      if (changes === 0) {
        duplicated++;
        if (this.conflictsWithExisting(reading, cabinetId, measuredAt, tempX10)) {
          conflicts.push({ deviceId: reading.deviceId, seq: reading.seq });
        }
        continue;
      }

      inserted.push({ cabinetId, measuredAt, tempX10 });
      const range = affected.get(cabinetId);
      affected.set(cabinetId, {
        from: Math.min(range?.from ?? measuredAt, measuredAt),
        to: Math.max(range?.to ?? measuredAt, measuredAt),
      });
    }

    return {
      response: {
        accepted: inserted.length,
        duplicated,
        rejectedCount: rejected.length,
        rejected,
      },
      affected,
      inserted,
      conflicts,
    };
  }

  /**
   * 寫入被忽略時有兩種重複：
   * - 同一流水號（裝置重送）
   * - 同一冷藏櫃同一量測時間（例如韌體重開機後用新流水號重送本機緩衝）
   * 內容與既有紀錄不同時回報衝突，但不覆寫原始紀錄
   */
  private conflictsWithExisting(
    reading: ReadingInput,
    cabinetId: string,
    measuredAt: number,
    tempX10: number,
  ): boolean {
    const sameSeq = get<{ measured_at: number; temp_x10: number }>(
      this.db,
      'SELECT measured_at, temp_x10 FROM readings WHERE device_id = ? AND seq = ?',
      [reading.deviceId, reading.seq],
    );
    if (sameSeq) return sameSeq.measured_at !== measuredAt || sameSeq.temp_x10 !== tempX10;

    const sameTime = get<{ temp_x10: number }>(
      this.db,
      'SELECT temp_x10 FROM readings WHERE cabinet_id = ? AND measured_at = ?',
      [cabinetId, measuredAt],
    );
    return sameTime !== undefined && sameTime.temp_x10 !== tempX10;
  }
}
