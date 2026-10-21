import { describe, expect, it } from 'vitest';
import { MINUTE_MS } from '@coldtrace/shared';
import { insertGaps, mergePoints } from './series';

const m = (n: number) => n * MINUTE_MS;

describe('insertGaps', () => {
  it('連續資料不插入缺口，溫度轉回 °C', () => {
    expect(
      insertGaps([
        [m(0), 45],
        [m(1), 46],
        [m(3), 47],
      ]),
    ).toEqual([
      [m(0), 4.5],
      [m(1), 4.6],
      [m(3), 4.7],
    ]);
  });

  it('間隔超過 3 分鐘時插入 null 讓線條中斷', () => {
    expect(
      insertGaps([
        [m(0), 45],
        [m(120), 46],
      ]),
    ).toEqual([
      [m(0), 4.5],
      [m(1), null],
      [m(120), 4.6],
    ]);
  });
});

describe('mergePoints', () => {
  it('去重、排序並修剪視窗外資料', () => {
    const merged = mergePoints(
      [
        [m(0), 40],
        [m(1), 41],
        [m(2), 42],
      ],
      [
        [m(3), 43],
        [m(2), 42],
      ],
      m(1),
    );
    expect(merged).toEqual([
      [m(1), 41],
      [m(2), 42],
      [m(3), 43],
    ]);
  });
});
