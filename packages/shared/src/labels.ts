import type { CabinetStatus, EventDto, ExcursionStatus, OfflineStatus } from './api';

export const CABINET_STATUS_LABEL: Record<CabinetStatus, string> = {
  NORMAL: '正常',
  ALERT: '異常',
  OFFLINE: '斷線',
};

export const EVENT_TYPE_LABEL = { EXCURSION: '溫度異常', OFFLINE: '斷線' } as const;

const EXCURSION_STATUS_LABEL: Record<ExcursionStatus, string> = {
  OPEN: '進行中',
  CLOSED: '已結束',
  MERGED: '已合併',
};

const OFFLINE_STATUS_LABEL: Record<OfflineStatus, string> = {
  OPEN: '斷線中',
  BACKFILLED_NORMAL: '已補齊、溫度正常',
  BACKFILLED_EXCURSION: '補傳顯示超標',
  INCOMPLETE: '資料不完整',
};

export function eventStatusLabel(event: Pick<EventDto, 'type' | 'status'>): string {
  return event.type === 'EXCURSION'
    ? EXCURSION_STATUS_LABEL[event.status as ExcursionStatus]
    : OFFLINE_STATUS_LABEL[event.status as OfflineStatus];
}
