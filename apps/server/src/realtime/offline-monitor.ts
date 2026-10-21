import type { Clock } from '../infra/clock';

const SCAN_INTERVAL_MS = 30_000;
const MIN_REAL_INTERVAL_MS = 250;

/**
 * 定期執行斷線掃描。實際間隔依時鐘倍率縮短，
 * 確保加速展示時仍以「模擬時間每 30 秒」的頻率檢查。
 */
export function startOfflineMonitor(
  clock: Clock,
  scan: (now: number) => void,
  onError: (error: unknown) => void,
): () => void {
  const interval = Math.max(MIN_REAL_INTERVAL_MS, SCAN_INTERVAL_MS / clock.speed);
  const timer = setInterval(() => {
    try {
      scan(clock.now());
    } catch (error) {
      onError(error);
    }
  }, interval);
  return () => clearInterval(timer);
}
