import { MAX_CONTINUOUS_GAP_MS, SAMPLE_INTERVAL_MS } from '@coldtrace/shared';

/**
 * [from, to) 期間的資料是否完整：每筆讀值涵蓋 1 分鐘，
 * 任何未被涵蓋的空白都不得超過容忍的缺口（與異常判定的連續規則一致）。
 */
export function isFullyCovered(sortedTimes: readonly number[], from: number, to: number): boolean {
  let coveredUntil = from;
  for (const t of sortedTimes) {
    if (t + SAMPLE_INTERVAL_MS <= from || t >= to) continue;
    if (t - coveredUntil > MAX_CONTINUOUS_GAP_MS) return false;
    coveredUntil = Math.max(coveredUntil, t + SAMPLE_INTERVAL_MS);
  }
  return to - coveredUntil <= MAX_CONTINUOUS_GAP_MS;
}
