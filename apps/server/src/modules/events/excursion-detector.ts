import {
  EXCURSION_MIN_DURATION_MS,
  MAX_CONTINUOUS_GAP_MS,
  SAMPLE_INTERVAL_MS,
  exceedanceX10,
  isInRange,
} from '@coldtrace/shared';

export interface Sample {
  t: number;
  tempX10: number;
}

export interface ExcursionRun {
  /** 第一筆超標讀值時間 */
  start: number;
  /** 最後一筆超標讀值時間 */
  lastOutAt: number;
  /**
   * 回到範圍的時間：
   * - 緊接著有正常讀值 → 該讀值時間
   * - 之後出現超過容忍的資料缺口 → 最後一筆超標 + 1 分鐘（實際恢復時間未知）
   * - 資料到此為止仍在超標 → null
   */
  end: number | null;
  /** 最後一筆超標 + 1 分鐘 − 第一筆超標 */
  durationMs: number;
  maxTempX10: number;
  minTempX10: number;
  degreeMinutesX10: number;
  established: boolean;
}

/** 相鄰兩筆讀值的間隔不超過此值，就視為連續 */
const MAX_STEP_MS = SAMPLE_INTERVAL_MS + MAX_CONTINUOUS_GAP_MS;

interface Building {
  start: number;
  lastOutAt: number;
  maxTempX10: number;
  minTempX10: number;
  degreeMinutesX10: number;
}

function finish(run: Building, end: number | null): ExcursionRun {
  const durationMs = run.lastOutAt + SAMPLE_INTERVAL_MS - run.start;
  return { ...run, end, durationMs, established: durationMs >= EXCURSION_MIN_DURATION_MS };
}

/**
 * 從量測序列找出所有超標連續段（純函數，不依賴輸入順序與現在時間）。
 * 每筆讀值代表 1 分鐘。
 */
export function detectExcursionRuns(input: readonly Sample[]): ExcursionRun[] {
  const samples = [...input].sort((a, b) => a.t - b.t);
  const runs: ExcursionRun[] = [];
  let current: Building | null = null;

  for (const { t, tempX10 } of samples) {
    const continuous = current !== null && t - current.lastOutAt <= MAX_STEP_MS;

    if (current && !continuous) {
      runs.push(finish(current, current.lastOutAt + SAMPLE_INTERVAL_MS));
      current = null;
    }

    if (isInRange(tempX10)) {
      if (current) {
        runs.push(finish(current, t));
        current = null;
      }
      continue;
    }

    if (current) {
      current.lastOutAt = t;
      current.maxTempX10 = Math.max(current.maxTempX10, tempX10);
      current.minTempX10 = Math.min(current.minTempX10, tempX10);
      current.degreeMinutesX10 += exceedanceX10(tempX10);
    } else {
      current = {
        start: t,
        lastOutAt: t,
        maxTempX10: tempX10,
        minTempX10: tempX10,
        degreeMinutesX10: exceedanceX10(tempX10),
      };
    }
  }

  if (current) runs.push(finish(current, null));
  return runs;
}
