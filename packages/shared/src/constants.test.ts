import { describe, expect, it } from 'vitest';
import { exceedanceX10, isInRange, toX10 } from './constants';

describe('溫度範圍', () => {
  it('2.0 與 8.0 本身算在範圍內', () => {
    expect(isInRange(20)).toBe(true);
    expect(isInRange(80)).toBe(true);
    expect(isInRange(19)).toBe(false);
    expect(isInRange(81)).toBe(false);
  });

  it('超出量分別計算高溫與低溫', () => {
    expect(exceedanceX10(95)).toBe(15);
    expect(exceedanceX10(15)).toBe(5);
    expect(exceedanceX10(50)).toBe(0);
  });

  it('toX10 消除浮點誤差', () => {
    expect(toX10(8.1)).toBe(81);
    expect(toX10(0.1 + 0.2)).toBe(3);
  });
});
