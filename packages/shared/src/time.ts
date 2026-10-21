export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** 台灣沒有日光節約時間，固定 UTC+8 */
export const TAIPEI_OFFSET_MS = 8 * HOUR_MS;
export const TAIPEI_TZ = 'Asia/Taipei';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonth(month: string): { year: number; month: number } {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new Error(`月份格式錯誤，應為 YYYY-MM：${month}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

/** 回傳台灣時間該月份的 [from, to) epoch 毫秒 */
export function taipeiMonthRange(month: string): { from: number; to: number } {
  const { year, month: m } = parseMonth(month);
  const from = Date.UTC(year, m - 1, 1) - TAIPEI_OFFSET_MS;
  const to = Date.UTC(year, m, 1) - TAIPEI_OFFSET_MS;
  return { from, to };
}

/** 'YYYY-MM-DD HH:mm'（台灣時間） */
export function formatTaipei(epochMs: number, withSeconds = false): string {
  const iso = new Date(epochMs + TAIPEI_OFFSET_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, withSeconds ? 19 : 16)}`;
}

/** 目前時間所在的台灣月份 'YYYY-MM' */
export function taipeiMonthOf(epochMs: number): string {
  return new Date(epochMs + TAIPEI_OFFSET_MS).toISOString().slice(0, 7);
}
