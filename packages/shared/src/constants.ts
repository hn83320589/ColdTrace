import { HOUR_MS, MINUTE_MS } from './time';

/** 溫度一律以 0.1°C 為單位的整數處理，避免浮點誤差 */
export const TEMP_MIN_X10 = 20;
export const TEMP_MAX_X10 = 80;

/** 連續超標達此時間才成立溫度異常事件 */
export const EXCURSION_MIN_DURATION_MS = 10 * MINUTE_MS;
/** 連續段中缺資料不超過此長度，仍視為連續 */
export const MAX_CONTINUOUS_GAP_MS = 2 * MINUTE_MS;
/** 冷藏櫃超過此時間沒有資料就成立斷線事件 */
export const OFFLINE_THRESHOLD_MS = 15 * MINUTE_MS;
/** 接受補傳的最長時間 */
export const BACKFILL_WINDOW_MS = 72 * HOUR_MS;
/** 容忍裝置時鐘超前的範圍 */
export const FUTURE_TOLERANCE_MS = 5 * MINUTE_MS;
/** 一筆讀值代表的時間長度 */
export const SAMPLE_INTERVAL_MS = MINUTE_MS;
export const MAX_BATCH_SIZE = 1000;

export function isInRange(tempX10: number): boolean {
  return tempX10 >= TEMP_MIN_X10 && tempX10 <= TEMP_MAX_X10;
}

/** 超出 2–8°C 的量（0.1°C 單位），範圍內為 0 */
export function exceedanceX10(tempX10: number): number {
  if (tempX10 > TEMP_MAX_X10) return tempX10 - TEMP_MAX_X10;
  if (tempX10 < TEMP_MIN_X10) return TEMP_MIN_X10 - tempX10;
  return 0;
}

export function toX10(celsius: number): number {
  return Math.round(celsius * 10);
}

export function fromX10(x10: number): number {
  return x10 / 10;
}
