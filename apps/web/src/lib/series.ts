import { MAX_CONTINUOUS_GAP_MS, SAMPLE_INTERVAL_MS, type ReadingPoint } from '@coldtrace/shared';

export type ChartPoint = [number, number | null];

/** 相鄰兩點間隔超過可容忍缺口時插入 null，讓折線在斷線處中斷 */
export function insertGaps(
  points: readonly ReadingPoint[],
  maxStepMs = SAMPLE_INTERVAL_MS + MAX_CONTINUOUS_GAP_MS,
): ChartPoint[] {
  const result: ChartPoint[] = [];
  let previous: number | null = null;
  for (const [t, v] of points) {
    if (previous !== null && t - previous > maxStepMs)
      result.push([previous + SAMPLE_INTERVAL_MS, null]);
    result.push([t, v / 10]);
    previous = t;
  }
  return result;
}

/** 即時新增的點合併進既有序列：去重、排序，並丟掉視窗之外的舊資料 */
export function mergePoints(
  existing: readonly ReadingPoint[],
  incoming: readonly ReadingPoint[],
  windowFrom: number,
): ReadingPoint[] {
  const byTime = new Map<number, ReadingPoint>();
  for (const p of existing) if (p[0] >= windowFrom) byTime.set(p[0], p);
  for (const p of incoming) if (p[0] >= windowFrom) byTime.set(p[0], p);
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}
