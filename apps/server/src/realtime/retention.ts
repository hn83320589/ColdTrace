import { DAY_MS } from '@coldtrace/shared';
import type { Clock } from '../infra/clock';
import { run, type Db } from '../infra/db';

/** 量測資料保存兩年 */
export const RETENTION_MS = 730 * DAY_MS;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 刪除超過保存期限的量測資料；事件、通知、處置紀錄量小且具稽核價值，予以保留 */
export function purgeExpiredReadings(db: Db, now: number): number {
  return run(db, 'DELETE FROM readings WHERE measured_at < ?', [now - RETENTION_MS]).changes;
}

export function startRetentionJob(
  db: Db,
  clock: Clock,
  onError: (error: unknown) => void,
): () => void {
  const tick = () => {
    try {
      purgeExpiredReadings(db, clock.now());
    } catch (error) {
      onError(error);
    }
  };
  tick();
  const timer = setInterval(tick, PURGE_INTERVAL_MS);
  return () => clearInterval(timer);
}
