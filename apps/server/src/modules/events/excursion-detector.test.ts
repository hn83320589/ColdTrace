import { describe, expect, it } from 'vitest';
import { MINUTE_MS, toX10 } from '@coldtrace/shared';
import { detectExcursionRuns, type Sample } from './excursion-detector';

const T = Date.parse('2026-10-21T10:00:00+08:00');
const at = (minute: number) => T + minute * MINUTE_MS;

/** 從第 0 分鐘起每分鐘一筆；null 代表該分鐘沒有資料 */
function samples(temps: (number | null)[]): Sample[] {
  return temps.flatMap((temp, i) => (temp === null ? [] : [{ t: at(i), tempX10: toX10(temp) }]));
}
const repeat = (v: number, n: number) => Array<number>(n).fill(v);

describe('detectExcursionRuns', () => {
  it('全部在範圍內時沒有任何連續段', () => {
    expect(detectExcursionRuns(samples([2.0, 5.0, 8.0, 7.9]))).toEqual([]);
  });

  it('超標 9 分鐘後回到範圍 → 不成立事件', () => {
    const [run] = detectExcursionRuns(samples([5, ...repeat(9, 9), 5]));
    expect(run).toMatchObject({ durationMs: 9 * MINUTE_MS, established: false });
  });

  it('超標 10 分鐘 → 成立事件，記錄起訖時間', () => {
    const [run] = detectExcursionRuns(samples([5, ...repeat(9, 10), 5]));
    expect(run).toMatchObject({
      start: at(1),
      end: at(11),
      durationMs: 10 * MINUTE_MS,
      established: true,
    });
  });

  it('剛好 2.0 與 8.0 不算超標', () => {
    expect(detectExcursionRuns(samples([...repeat(8.0, 15), ...repeat(2.0, 15)]))).toEqual([]);
  });

  it('低溫超標同樣成立事件，並記錄最高與最低溫', () => {
    const [run] = detectExcursionRuns(samples([1.9, 1.5, 0.8, ...repeat(1.0, 8), 3.0]));
    expect(run).toMatchObject({ established: true, minTempX10: 8, maxTempX10: 19 });
  });

  it('累積超標度分鐘與手算一致', () => {
    // 超出量 0.5+1.0+1.5+2.0+2.0+1.5+1.0+0.5+0.2+0.1 = 10.3 度分鐘
    const temps = [8.5, 9.0, 9.5, 10.0, 10.0, 9.5, 9.0, 8.5, 8.2, 8.1];
    const [run] = detectExcursionRuns(samples([5, ...temps, 5]));
    expect(run?.degreeMinutesX10).toBe(103);
    expect(run?.maxTempX10).toBe(100);
    expect(run?.minTempX10).toBe(81);
  });

  it('連續段中缺資料 ≤ 2 分鐘仍視為連續，但缺口不累計度分鐘', () => {
    const [run, ...rest] = detectExcursionRuns(
      samples([...repeat(9, 5), null, null, ...repeat(9, 5), 5]),
    );
    expect(rest).toEqual([]);
    expect(run).toMatchObject({
      durationMs: 12 * MINUTE_MS,
      degreeMinutesX10: 100,
      established: true,
    });
  });

  it('缺資料 > 2 分鐘就切斷為兩段', () => {
    const runs = detectExcursionRuns(samples([...repeat(9, 6), null, null, null, ...repeat(9, 6)]));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => !r.established)).toBe(true);
    expect(runs[0]?.end).toBe(at(6)); // 不知道何時恢復，以最後一筆超標 + 1 分鐘為結束
  });

  it('資料到此仍在超標中 → end 為 null', () => {
    const [run] = detectExcursionRuns(samples([5, ...repeat(9, 12)]));
    expect(run).toMatchObject({ end: null, lastOutAt: at(12), established: true });
  });

  it('輸入順序不影響結果（補傳亂序）', () => {
    const ordered = samples([5, ...repeat(9.5, 10), 6, ...repeat(1.0, 11), 5]);
    const shuffled = [...ordered].reverse();
    expect(detectExcursionRuns(shuffled)).toEqual(detectExcursionRuns(ordered));
    expect(detectExcursionRuns(ordered)).toHaveLength(2);
  });
});
