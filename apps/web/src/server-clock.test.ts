import { describe, expect, it } from 'vitest';
import { estimateServerNow } from './server-clock';

describe('estimateServerNow', () => {
  it('依倍率推算伺服器時間', () => {
    expect(estimateServerNow({ now: 1_000_000, speed: 60 }, 5_000, 6_000)).toBe(1_060_000);
    expect(estimateServerNow({ now: 1_000_000, speed: 1 }, 5_000, 6_000)).toBe(1_001_000);
  });
});
