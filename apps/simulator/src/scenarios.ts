import { MINUTE_MS, TemperatureModel, createRng } from '@coldtrace/shared';

export const SCENARIOS = ['normal', 'door-open', 'compressor-failure', 'offline-backfill'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export function isScenario(value: string): value is ScenarioName {
  return (SCENARIOS as readonly string[]).includes(value);
}

/** 斷線 2 小時，期間第 40 分鐘起超標 30 分鐘 */
export const OFFLINE_DURATION_MIN = 120;
export const OFFLINE_EXCURSION_OFFSET_MIN = 40;
export const OFFLINE_EXCURSION_MIN = 30;
/** 開門每 20 分鐘一次，每次 5 分鐘 */
export const DOOR_INTERVAL_MIN = 20;
export const DOOR_DURATION_MIN = 5;
/** 壓縮機故障：每分鐘升 0.25°C，約 14 分鐘後超標，超標約 88 分鐘 */
export const COMPRESSOR_DURATION_MIN = 90;
export const COMPRESSOR_RISE_PER_MIN = 0.25;

export interface DevicePlan {
  model: TemperatureModel;
  /** [from, to) 期間不上傳，資料存在裝置本機 */
  offline: { from: number; to: number } | null;
}

/**
 * 依情境建立裝置的溫度模型與斷線計畫。
 * incidentAt：情境開始時間；horizon：最遠模擬到的時間（用於排程重複開門）。
 */
export function buildPlan(
  scenario: ScenarioName,
  seed: number,
  incidentAt: number,
  horizon: number,
): DevicePlan {
  const model = new TemperatureModel(createRng(seed), 4 + (seed % 10) / 10);
  let offline: DevicePlan['offline'] = null;

  switch (scenario) {
    case 'normal':
      break;
    case 'door-open':
      for (let t = incidentAt; t < horizon; t += DOOR_INTERVAL_MIN * MINUTE_MS) {
        model.addIncident({
          kind: 'door-open',
          start: t,
          durationMin: DOOR_DURATION_MIN,
          peak: 9.5,
        });
      }
      break;
    case 'compressor-failure':
      model.addIncident({
        kind: 'compressor-failure',
        start: incidentAt,
        durationMin: COMPRESSOR_DURATION_MIN,
        peak: 11,
        risePerMin: COMPRESSOR_RISE_PER_MIN,
      });
      break;
    case 'offline-backfill':
      offline = { from: incidentAt, to: incidentAt + OFFLINE_DURATION_MIN * MINUTE_MS };
      model.addIncident({
        kind: 'plateau',
        start: incidentAt + OFFLINE_EXCURSION_OFFSET_MIN * MINUTE_MS,
        durationMin: OFFLINE_EXCURSION_MIN,
        value: 9.6,
      });
      break;
  }
  return { model, offline };
}
