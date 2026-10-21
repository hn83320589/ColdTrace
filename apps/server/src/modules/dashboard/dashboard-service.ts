import {
  DAY_MS,
  type BranchDashboard,
  type CabinetSnapshot,
  type CabinetStatus,
  type ReadingPoint,
  type WsMessage,
} from '@coldtrace/shared';
import { all, get, type Db } from '../../infra/db';

interface CabinetRow {
  cabinet_id: string;
  cabinet_name: string;
  branch_id: string;
  branch_name: string;
}

export function deriveStatus(
  openOfflineId: number | null,
  openExcursionId: number | null,
): CabinetStatus {
  if (openOfflineId !== null) return 'OFFLINE';
  if (openExcursionId !== null) return 'ALERT';
  return 'NORMAL';
}

export class DashboardService {
  constructor(private readonly db: Db) {}

  snapshot(now: number): BranchDashboard[] {
    const rows = all<CabinetRow>(
      this.db,
      `SELECT c.id AS cabinet_id, c.name AS cabinet_name, b.id AS branch_id, b.name AS branch_name
       FROM cabinets c JOIN branches b ON b.id = c.branch_id ORDER BY b.id, c.id`,
    );
    const branches = new Map<string, BranchDashboard>();
    for (const row of rows) {
      const branch = branches.get(row.branch_id) ?? {
        branchId: row.branch_id,
        branchName: row.branch_name,
        cabinets: [],
      };
      branch.cabinets.push(this.buildSnapshot(row, now));
      branches.set(row.branch_id, branch);
    }
    return [...branches.values()];
  }

  cabinet(cabinetId: string, now: number): CabinetSnapshot | null {
    const row = get<CabinetRow>(
      this.db,
      `SELECT c.id AS cabinet_id, c.name AS cabinet_name, b.id AS branch_id, b.name AS branch_name
       FROM cabinets c JOIN branches b ON b.id = c.branch_id WHERE c.id = ?`,
      [cabinetId],
    );
    return row ? this.buildSnapshot(row, now) : null;
  }

  readings(cabinetId: string, from: number, to: number): ReadingPoint[] {
    return all<{ t: number; v: number }>(
      this.db,
      `SELECT measured_at AS t, temp_x10 AS v FROM readings
       WHERE cabinet_id = ? AND measured_at >= ? AND measured_at <= ? ORDER BY measured_at`,
      [cabinetId, from, to],
    ).map((r) => [r.t, r.v]);
  }

  defaultRange(now: number): { from: number; to: number } {
    return { from: now - DAY_MS, to: now };
  }

  /** 為受影響的冷藏櫃補上最新狀態快照 */
  withStatusUpdates(messages: WsMessage[], now: number): WsMessage[] {
    const cabinetIds = new Set<string>();
    for (const m of messages) {
      if (m.type === 'series.appended' || m.type === 'series.changed') cabinetIds.add(m.cabinetId);
      if (m.type === 'event.updated') cabinetIds.add(m.event.cabinetId);
      if (m.type === 'notification.created') cabinetIds.add(m.notification.cabinetId);
    }
    const updates: WsMessage[] = [];
    for (const id of cabinetIds) {
      const cabinet = this.cabinet(id, now);
      if (cabinet) updates.push({ type: 'cabinet.status', cabinet });
    }
    return [...messages, ...updates];
  }

  private buildSnapshot(row: CabinetRow, now: number): CabinetSnapshot {
    const id = row.cabinet_id;
    const device = get<{ device_id: string }>(
      this.db,
      `SELECT device_id FROM bindings
       WHERE cabinet_id = ? AND bound_from <= ? AND (bound_to IS NULL OR bound_to > ?)`,
      [id, now, now],
    );
    const latest = get<{ measured_at: number; temp_x10: number; battery: number }>(
      this.db,
      `SELECT measured_at, temp_x10, battery FROM readings
       WHERE cabinet_id = ? ORDER BY measured_at DESC LIMIT 1`,
      [id],
    );
    const openId = (type: string) =>
      get<{ id: number }>(
        this.db,
        `SELECT id FROM events WHERE cabinet_id = ? AND type = ? AND status = 'OPEN'
         ORDER BY started_at DESC LIMIT 1`,
        [id, type],
      )?.id ?? null;
    const openOfflineId = openId('OFFLINE');
    const openExcursionId = openId('EXCURSION');

    return {
      cabinetId: id,
      cabinetName: row.cabinet_name,
      branchId: row.branch_id,
      deviceId: device?.device_id ?? null,
      status: deriveStatus(openOfflineId, openExcursionId),
      currentTempX10: latest?.temp_x10 ?? null,
      battery: latest?.battery ?? null,
      lastReportedAt: latest?.measured_at ?? null,
      openExcursionId,
      openOfflineId,
    };
  }
}
