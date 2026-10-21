import {
  MAX_BATCH_SIZE,
  MINUTE_MS,
  type IngestResponse,
  type ReadingInput,
} from '@coldtrace/shared';
import type { DevicePlan } from './scenarios';

export type Uploader = (readings: ReadingInput[]) => Promise<IngestResponse>;

export interface DeviceStats {
  sent: number;
  accepted: number;
  duplicated: number;
  rejected: number;
  failedUploads: number;
}

/**
 * 模擬一支溫度計：每分鐘量測一筆，離線或上傳失敗時存在本機緩衝，
 * 恢復後依時間先後補傳（每批最多 1,000 筆）。
 */
export class SimulatedDevice {
  private buffer: ReadingInput[] = [];
  readonly stats: DeviceStats = {
    sent: 0,
    accepted: 0,
    duplicated: 0,
    rejected: 0,
    failedUploads: 0,
  };

  constructor(
    readonly id: string,
    private seq: number,
    /** 下一筆要量測的時間（整分鐘） */
    private nextAt: number,
    private readonly plan: DevicePlan,
  ) {}

  get pending(): number {
    return this.buffer.length;
  }

  isOnline(t: number): boolean {
    const off = this.plan.offline;
    return !off || t < off.from || t >= off.to;
  }

  /** 產生到 now 為止的所有量測，在線上時上傳緩衝 */
  async tick(now: number, upload: Uploader): Promise<void> {
    while (this.nextAt <= now) {
      this.buffer.push({
        deviceId: this.id,
        seq: ++this.seq,
        measuredAt: new Date(this.nextAt).toISOString(),
        temperature: this.plan.model.sample(this.nextAt),
        battery: 85,
      });
      this.nextAt += MINUTE_MS;
    }
    if (this.isOnline(now)) await this.flush(upload);
  }

  private async flush(upload: Uploader): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.slice(0, MAX_BATCH_SIZE);
      try {
        const res = await upload(batch);
        this.stats.sent += batch.length;
        this.stats.accepted += res.accepted;
        this.stats.duplicated += res.duplicated;
        this.stats.rejected += res.rejectedCount;
        this.buffer = this.buffer.slice(batch.length);
      } catch {
        // 網路或伺服器錯誤：保留在本機，下次再送（伺服器端冪等，重送不會重複寫入）
        this.stats.failedUploads++;
        return;
      }
    }
  }
}
