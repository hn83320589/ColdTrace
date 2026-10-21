import { describe, expect, it } from 'vitest';
import { eventStatusLabel, formatAgo, formatDuration, formatTemp } from './format';

describe('format', () => {
  it('溫度顯示小數一位', () => {
    expect(formatTemp(45)).toBe('4.5°C');
    expect(formatTemp(-5)).toBe('-0.5°C');
    expect(formatTemp(null)).toBe('—');
  });

  it('持續時間', () => {
    expect(formatDuration(30 * 60_000)).toBe('30 分鐘');
    expect(formatDuration(125 * 60_000)).toBe('2 小時 5 分鐘');
  });

  it('相對時間', () => {
    expect(formatAgo(0, 90_000)).toBe('1 分鐘前');
    expect(formatAgo(null, 0)).toBe('從未回報');
  });

  it('斷線事件狀態標籤', () => {
    expect(eventStatusLabel({ type: 'OFFLINE', status: 'BACKFILLED_NORMAL' })).toBe(
      '已補齊、溫度正常',
    );
  });
});
