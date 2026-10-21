import { MINUTE_MS } from './time';

/**
 * 溫度情境（模擬器與範例資料共用）。start 為 epoch 毫秒。
 * - door-open：開門短暫升溫，正弦曲線升到 peak 後回落
 * - compressor-failure：每分鐘緩升（預設 0.1°C）到 peak 並維持，durationMin 後修復、每分鐘降 0.25°C
 * - freeze：每分鐘降 0.15°C 到 low 並維持，durationMin 後回升
 * - plateau：在 durationMin 期間固定於 value 附近（用於精準控制超標時長）
 */
export type Incident =
  | { kind: 'door-open'; start: number; durationMin: number; peak: number }
  | {
      kind: 'compressor-failure';
      start: number;
      durationMin: number;
      peak: number;
      /** 每分鐘升溫幅度，預設 0.1°C */
      risePerMin?: number;
    }
  | { kind: 'freeze'; start: number; durationMin: number; low: number }
  | { kind: 'plateau'; start: number; durationMin: number; value: number };

/** mulberry32：可重現的亂數，讓範例資料與測試結果固定 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RISE_PER_MIN = 0.1;
const RECOVER_PER_MIN = 0.25;
const FREEZE_PER_MIN = 0.15;

/** 套用情境後的溫度；不在情境期間時回傳 null */
export function incidentTemperature(
  incident: Incident,
  t: number,
  baseline: number,
): number | null {
  const m = (t - incident.start) / MINUTE_MS;
  if (m < 0) return null;
  const d = incident.durationMin;

  switch (incident.kind) {
    case 'door-open':
      return m < d ? baseline + (incident.peak - baseline) * Math.sin((Math.PI * m) / d) : null;
    case 'plateau':
      return m < d ? incident.value : null;
    case 'compressor-failure': {
      const rise = incident.risePerMin ?? RISE_PER_MIN;
      const reached = Math.min(incident.peak, baseline + rise * Math.min(m, d));
      if (m < d) return reached;
      const recovered = reached - RECOVER_PER_MIN * (m - d);
      return recovered > baseline ? recovered : null;
    }
    case 'freeze': {
      const reached = Math.max(incident.low, baseline - FREEZE_PER_MIN * Math.min(m, d));
      if (m < d) return reached;
      const recovered = reached + RECOVER_PER_MIN * (m - d);
      return recovered < baseline ? recovered : null;
    }
  }
}

export class TemperatureModel {
  private readonly incidents: Incident[] = [];

  constructor(
    private readonly rng: () => number,
    private readonly baseline = 4.5,
  ) {}

  addIncident(incident: Incident): void {
    this.incidents.push(incident);
  }

  /** 回傳小數一位的溫度 */
  sample(t: number): number {
    const drift = 0.3 * Math.sin((2 * Math.PI * t) / (6 * 60 * MINUTE_MS));
    const noise = (this.rng() - 0.5) * 0.3;
    let value = this.baseline + drift + noise;
    for (const incident of this.incidents) {
      const v = incidentTemperature(incident, t, this.baseline + drift);
      if (v !== null) value = v + noise / 3;
    }
    return Math.round(value * 10) / 10;
  }
}
