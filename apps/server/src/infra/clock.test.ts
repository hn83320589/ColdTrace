import { describe, expect, it } from 'vitest';
import { FixedClock, ScaledClock } from './clock';

describe('Clock', () => {
  it('FixedClock 只在 advance 時前進', () => {
    const clock = new FixedClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
  });

  it('ScaledClock 以倍率流逝', () => {
    let real = 0;
    const clock = new ScaledClock(60, 1_000_000, () => real);
    real = 1000; // 真實 1 秒
    expect(clock.now()).toBe(1_000_000 + 60_000); // 模擬 1 分鐘
  });

  it('ScaledClock 拒絕非正數倍率', () => {
    expect(() => new ScaledClock(0)).toThrow(/CLOCK_SPEED/);
  });
});
