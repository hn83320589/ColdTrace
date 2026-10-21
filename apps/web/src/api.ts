import type {
  BindingDto,
  BranchDashboard,
  ClockInfo,
  DispositionInput,
  EventDetailDto,
  EventDto,
  MonthlyReport,
  NotificationDto,
  ReadingPoint,
} from '@coldtrace/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, body?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    (e): e is [string, string | number] => e[1] !== undefined && e[1] !== '',
  );
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : '';
}

export interface ReadingsResponse {
  cabinetId: string;
  from: number;
  to: number;
  points: ReadingPoint[];
}

export interface CabinetRow {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
}

export interface DeviceRow {
  id: string;
  model: string | null;
  lastSeq: number | null;
  cabinetId: string | null;
}

export type EventQuery = {
  type?: string | undefined;
  status?: string | undefined;
  cabinetId?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  limit?: number | undefined;
};

export const api = {
  dashboard: () => request<BranchDashboard[]>('/api/dashboard'),
  readings: (cabinetId: string, range?: { from: number; to: number }) =>
    request<ReadingsResponse>(`/api/cabinets/${cabinetId}/readings${query({ ...range })}`),
  events: (q: EventQuery) => request<EventDto[]>(`/api/events${query(q)}`),
  event: (id: number) => request<EventDetailDto>(`/api/events/${id}`),
  addDisposition: (id: number, input: DispositionInput) =>
    request<EventDetailDto>(`/api/events/${id}/dispositions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  notifications: (limit = 30) => request<NotificationDto[]>(`/api/notifications?limit=${limit}`),
  clock: () => request<ClockInfo>('/api/system/clock'),
  cabinets: () => request<CabinetRow[]>('/api/cabinets'),
  devices: () => request<DeviceRow[]>('/api/devices'),
  bindings: () => request<BindingDto[]>('/api/bindings'),
  replaceDevice: (cabinetId: string, newDeviceId: string, at?: string) =>
    request<BindingDto[]>(`/api/cabinets/${cabinetId}/device-replacement`, {
      method: 'POST',
      body: JSON.stringify({ newDeviceId, at }),
    }),
  monthlyReport: (month: string) => request<MonthlyReport>(`/api/reports/monthly?month=${month}`),
};
