import { describe, expect, it } from 'vitest';
import { createRng, incidentTemperature, TemperatureModel } from './temperature-model';
import { MINUTE_MS } from './time';

const minutesAbove8 = (model: TemperatureModel, start: number, minutes: number) =>
  Array.from({ length: minutes }, (_, i) => model.sample(start + i * MINUTE_MS)).filter(
    (v) => v > 8,
  ).length;

describe('TemperatureModel', () => {
  it('相同 seed 產生相同序列', () => {
    const a = new TemperatureModel(createRng(42));
    const b = new TemperatureModel(createRng(42));
    expect(a.sample(0)).toBe(b.sample(0));
    expect(a.sample(MINUTE_MS)).toBe(b.sample(MINUTE_MS));
  });

  it('正常情境維持在 2–8°C 且為小數一位', () => {
    const model = new TemperatureModel(createRng(1));
    for (let i = 0; i < 1440; i++) {
      const v = model.sample(i * MINUTE_MS);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(8);
      expect(Math.round(v * 10)).toBeCloseTo(v * 10, 6);
    }
  });

  it('開門 5 分鐘：短暫超標但少於 10 分鐘', () => {
    const model = new TemperatureModel(createRng(1));
    model.addIncident({ kind: 'door-open', start: 0, durationMin: 5, peak: 9.5 });
    const above = minutesAbove8(model, 0, 30);
    expect(above).toBeGreaterThan(0);
    expect(above).toBeLessThan(10);
  });

  it('壓縮機故障 120 分鐘：超標超過 1 小時', () => {
    const model = new TemperatureModel(createRng(1));
    model.addIncident({ kind: 'compressor-failure', start: 0, durationMin: 120, peak: 11 });
    expect(minutesAbove8(model, 0, 200)).toBeGreaterThan(60);
  });

  it('plateau 精準控制超標分鐘數', () => {
    const model = new TemperatureModel(createRng(1));
    model.addIncident({ kind: 'plateau', start: 10 * MINUTE_MS, durationMin: 30, value: 9.5 });
    expect(minutesAbove8(model, 0, 60)).toBe(30);
  });

  it('情境開始前不影響溫度', () => {
    const incident = { kind: 'freeze', start: MINUTE_MS, durationMin: 10, low: 1 } as const;
    expect(incidentTemperature(incident, 0, 4.5)).toBeNull();
  });
});
