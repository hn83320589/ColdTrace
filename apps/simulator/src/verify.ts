import {
  EXCURSION_MIN_DURATION_MS,
  MINUTE_MS,
  OFFLINE_THRESHOLD_MS,
  type EventDto,
} from '@coldtrace/shared';
import {
  COMPRESSOR_RISE_PER_MIN,
  OFFLINE_DURATION_MIN,
  OFFLINE_EXCURSION_MIN,
  OFFLINE_EXCURSION_OFFSET_MIN,
  type ScenarioName,
} from './scenarios';

export interface Verdict {
  ok: boolean;
  /** 尚未經過足夠時間，無法判定 */
  pending: boolean;
  detail: string;
}

/** 壓縮機故障約幾分鐘後成立事件：升溫到 8°C 以上 + 連續 10 分鐘 */
const COMPRESSOR_ESTABLISH_MIN =
  Math.ceil(4 / COMPRESSOR_RISE_PER_MIN) + EXCURSION_MIN_DURATION_MS / MINUTE_MS + 2;

/**
 * 依情境檢查後端判定的事件（只看模擬開始後的事件）。
 * elapsedMin：情境開始後經過的模擬分鐘數。
 */
export function verifyScenario(
  scenario: ScenarioName,
  events: EventDto[],
  elapsedMin: number,
): Verdict {
  const excursions = events.filter((e) => e.type === 'EXCURSION');
  const offline = events.filter((e) => e.type === 'OFFLINE');

  switch (scenario) {
    case 'normal':
    case 'door-open':
      return excursions.length === 0 && offline.length === 0
        ? { ok: true, pending: false, detail: '無事件（符合預期）' }
        : {
            ok: false,
            pending: false,
            detail: `不應有事件，實際 ${excursions.length} 個異常、${offline.length} 個斷線`,
          };

    case 'compressor-failure':
      if (excursions.length === 1)
        return { ok: true, pending: false, detail: `溫度異常事件 #${excursions[0]!.id}` };
      if (excursions.length === 0 && elapsedMin < COMPRESSOR_ESTABLISH_MIN) {
        return { ok: true, pending: true, detail: `尚未滿 ${COMPRESSOR_ESTABLISH_MIN} 分鐘` };
      }
      return {
        ok: false,
        pending: false,
        detail: `預期 1 個溫度異常事件，實際 ${excursions.length} 個`,
      };

    case 'offline-backfill': {
      const offlineDue = OFFLINE_THRESHOLD_MS / MINUTE_MS + 2;
      if (elapsedMin < offlineDue) return { ok: true, pending: true, detail: '尚未滿 15 分鐘' };
      if (offline.length !== 1)
        return {
          ok: false,
          pending: false,
          detail: `預期 1 個斷線事件，實際 ${offline.length} 個`,
        };
      const event = offline[0]!;
      if (elapsedMin < OFFLINE_DURATION_MIN + 2) {
        return event.status === 'OPEN'
          ? { ok: true, pending: true, detail: `斷線中（事件 #${event.id}），等待 2 小時後補傳` }
          : { ok: false, pending: false, detail: `斷線期間狀態應為 OPEN，實際 ${event.status}` };
      }
      const [excursion] = excursions;
      const checks = {
        斷線狀態為補傳顯示超標: event.status === 'BACKFILLED_EXCURSION',
        恰好一個異常事件: excursions.length === 1,
        異常開始於斷線後40分鐘:
          excursion?.startedAt === event.startedAt + OFFLINE_EXCURSION_OFFSET_MIN * MINUTE_MS,
        異常持續30分鐘: excursion?.durationMs === OFFLINE_EXCURSION_MIN * MINUTE_MS,
        互相關聯: excursion !== undefined && event.linkedEventIds.includes(excursion.id),
      };
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
      return failed.length === 0
        ? {
            ok: true,
            pending: false,
            detail: `斷線 #${event.id} 補傳後產生 30 分鐘異常 #${excursion!.id} 並互相關聯`,
          }
        : { ok: false, pending: false, detail: `未通過：${failed.join('、')}` };
    }
  }
}
