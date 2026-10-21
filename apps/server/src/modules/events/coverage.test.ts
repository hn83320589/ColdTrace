import { describe, expect, it } from 'vitest';
import { MINUTE_MS } from '@coldtrace/shared';
import { isFullyCovered } from './coverage';

const m = (n: number) => n * MINUTE_MS;
const minutes = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => m(from + i));

describe('isFullyCovered', () => {
  it('每分鐘都有資料 → 完整', () => {
    expect(isFullyCovered(minutes(0, 120), m(0), m(120))).toBe(true);
  });

  it('容忍 2 分鐘以內的缺口', () => {
    const times = [...minutes(0, 50), ...minutes(52, 120)];
    expect(isFullyCovered(times, m(0), m(120))).toBe(true);
  });

  it('中間缺 3 分鐘 → 不完整', () => {
    const times = [...minutes(0, 50), ...minutes(53, 120)];
    expect(isFullyCovered(times, m(0), m(120))).toBe(false);
  });

  it('尾端缺資料同樣不完整', () => {
    expect(isFullyCovered(minutes(0, 100), m(0), m(120))).toBe(false);
    expect(isFullyCovered([], m(0), m(10))).toBe(false);
  });
});
