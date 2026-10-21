import { describe, expect, it } from 'vitest';
import { formatTaipei, parseMonth, taipeiMonthRange } from './time';

describe('taipeiMonthRange', () => {
  it('以台灣時間 (UTC+8) 切月份邊界', () => {
    const { from, to } = taipeiMonthRange('2026-10');
    expect(new Date(from).toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect(new Date(to).toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });

  it('跨年的 12 月', () => {
    const { to } = taipeiMonthRange('2026-12');
    expect(new Date(to).toISOString()).toBe('2026-12-31T16:00:00.000Z');
  });
});

describe('parseMonth', () => {
  it('拒絕格式錯誤的月份', () => {
    expect(() => parseMonth('2026-13')).toThrow(/月份格式/);
    expect(() => parseMonth('202610')).toThrow(/月份格式/);
  });
});

describe('formatTaipei', () => {
  it('以台灣時間顯示', () => {
    expect(formatTaipei(Date.parse('2026-10-21T02:05:00Z'))).toBe('2026-10-21 10:05');
  });
});
