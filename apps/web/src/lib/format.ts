import {
  formatTaipei,
  type CabinetStatus,
  type EventDto,
  type OfflineStatus,
  type ExcursionStatus,
} from '@coldtrace/shared';

export const formatTemp = (x10: number | null | undefined): string =>
  x10 === null || x10 === undefined ? '—' : `${(x10 / 10).toFixed(1)}°C`;

export const formatTime = (t: number | null | undefined, withSeconds = false): string =>
  t === null || t === undefined ? '—' : formatTaipei(t, withSeconds);

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分鐘`;
  const h = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${h} 小時 ${rest} 分鐘` : `${h} 小時`;
}

export function formatAgo(t: number | null, now: number): string {
  if (t === null) return '從未回報';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export const CABINET_STATUS_LABEL: Record<CabinetStatus, string> = {
  NORMAL: '正常',
  ALERT: '異常',
  OFFLINE: '斷線',
};

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

export const EVENT_TYPE_LABEL = { EXCURSION: '溫度異常', OFFLINE: '斷線' } as const;

export function eventStatusLabel(event: Pick<EventDto, 'type' | 'status'>): string {
  return event.type === 'EXCURSION'
    ? EXCURSION_STATUS_LABEL[event.status as ExcursionStatus]
    : OFFLINE_STATUS_LABEL[event.status as OfflineStatus];
}

export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(2)}%`;
}
