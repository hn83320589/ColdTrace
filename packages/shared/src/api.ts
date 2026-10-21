import { z } from 'zod';
import { MAX_BATCH_SIZE } from './constants';

// ---------- 量測接收 ----------

export const readingInputSchema = z.object({
  deviceId: z.string().min(1),
  seq: z.number().int().positive(),
  measuredAt: z.iso.datetime({ offset: true }),
  temperature: z.number().finite(),
  battery: z.number().int().min(0).max(100),
});
export type ReadingInput = z.infer<typeof readingInputSchema>;

export const ingestRequestSchema = z.object({
  readings: z.array(readingInputSchema).min(1).max(MAX_BATCH_SIZE),
});
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const REJECT_REASONS = [
  'TOO_OLD',
  'FROM_FUTURE',
  'UNKNOWN_DEVICE',
  'UNBOUND',
  'INVALID_TEMPERATURE',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface RejectedReading {
  deviceId: string;
  seq: number;
  reason: RejectReason;
}

export interface IngestResponse {
  accepted: number;
  duplicated: number;
  rejectedCount: number;
  rejected: RejectedReading[];
}

// ---------- 主檔 ----------

export interface BindingDto {
  id: number;
  deviceId: string;
  cabinetId: string;
  boundFrom: number;
  boundTo: number | null;
}

export const deviceReplacementSchema = z.object({
  newDeviceId: z.string().min(1),
  at: z.iso.datetime({ offset: true }).optional(),
});
export type DeviceReplacementInput = z.infer<typeof deviceReplacementSchema>;

export const createBranchSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export const createCabinetSchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  name: z.string().min(1),
});
export const createDeviceSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1).optional(),
});

// ---------- 儀表板 ----------

export type CabinetStatus = 'NORMAL' | 'ALERT' | 'OFFLINE';

export interface CabinetSnapshot {
  cabinetId: string;
  cabinetName: string;
  branchId: string;
  deviceId: string | null;
  status: CabinetStatus;
  /** 0.1°C 為單位 */
  currentTempX10: number | null;
  battery: number | null;
  lastReportedAt: number | null;
  openExcursionId: number | null;
  openOfflineId: number | null;
}

export interface BranchDashboard {
  branchId: string;
  branchName: string;
  cabinets: CabinetSnapshot[];
}

/** [measuredAt, tempX10] */
export type ReadingPoint = [number, number];

// ---------- 事件 ----------

export type EventType = 'EXCURSION' | 'OFFLINE';
export type ExcursionStatus = 'OPEN' | 'CLOSED' | 'MERGED';
export type OfflineStatus =
  /** 斷線中 */
  | 'OPEN'
  /** 已補齊、溫度正常 */
  | 'BACKFILLED_NORMAL'
  /** 補傳資料顯示期間有超標，已關聯溫度異常事件 */
  | 'BACKFILLED_EXCURSION'
  /** 已恢復連線，但斷線期間資料仍有缺口 */
  | 'INCOMPLETE';

export interface EventDto {
  id: number;
  cabinetId: string;
  type: EventType;
  status: ExcursionStatus | OfflineStatus;
  startedAt: number;
  endedAt: number | null;
  detectedAt: number;
  durationMs: number | null;
  maxTempX10: number | null;
  minTempX10: number | null;
  degreeMinutesX10: number | null;
  backfilled: boolean;
  linkedEventIds: number[];
  latestDisposition: DispositionDto | null;
}

export interface EventDetailDto extends EventDto {
  dispositions: DispositionDto[];
}

export const dispositionInputSchema = z
  .object({
    handler: z.string().trim().min(1, '請填寫處置人'),
    note: z.string().trim().min(1, '請填寫處置說明'),
    vaccineDiscarded: z.boolean(),
    discardedQty: z.number().int().min(0).default(0),
  })
  .refine((d) => !d.vaccineDiscarded || d.discardedQty > 0, {
    message: '疫苗報廢時，報廢數量必須大於 0',
    path: ['discardedQty'],
  })
  .refine((d) => d.vaccineDiscarded || d.discardedQty === 0, {
    message: '未報廢時，報廢數量應為 0',
    path: ['discardedQty'],
  });
export type DispositionInput = z.infer<typeof dispositionInputSchema>;

export interface DispositionDto extends DispositionInput {
  id: number;
  eventId: number;
  createdAt: number;
}

// ---------- 通知 ----------

export type NotificationKind = 'EXCURSION_STARTED' | 'EXCURSION_ENDED' | 'OFFLINE_STARTED';

export interface NotificationDto {
  id: number;
  eventId: number;
  cabinetId: string;
  kind: NotificationKind;
  message: string;
  createdAt: number;
}

// ---------- 月報 ----------

export interface MonthlyCabinetReport {
  cabinetId: string;
  cabinetName: string;
  branchName: string;
  expectedMinutes: number;
  recordedMinutes: number;
  inRangeMinutes: number;
  /** 0–1，無資料時為 null */
  complianceRate: number | null;
  completenessRate: number | null;
  events: EventDto[];
}

export interface MonthlyReport {
  month: string;
  generatedAt: number;
  cabinets: MonthlyCabinetReport[];
}

// ---------- 系統 ----------

export interface ClockInfo {
  now: number;
  speed: number;
}

// ---------- WebSocket ----------

export type WsMessage =
  | { type: 'snapshot'; branches: BranchDashboard[] }
  | { type: 'cabinet.status'; cabinet: CabinetSnapshot }
  | { type: 'series.appended'; cabinetId: string; points: ReadingPoint[] }
  | { type: 'series.changed'; cabinetId: string; from: number; to: number }
  | { type: 'event.updated'; event: EventDto }
  | { type: 'notification.created'; notification: NotificationDto };
