import type { BindingDto } from '@coldtrace/shared';
import { all, get, run, transaction, type Db } from '../../infra/db';
import { DomainError, NotFoundError } from '../../infra/errors';

interface BindingRow {
  id: number;
  device_id: string;
  cabinet_id: string;
  bound_from: number;
  bound_to: number | null;
}

const toBindingDto = (r: BindingRow): BindingDto => ({
  id: r.id,
  deviceId: r.device_id,
  cabinetId: r.cabinet_id,
  boundFrom: r.bound_from,
  boundTo: r.bound_to,
});

/** 兩個半開區間 [from, to) 是否重疊，to 為 null 代表無限 */
const OVERLAP_SQL = `bound_from < COALESCE(?, 9e18) AND COALESCE(bound_to, 9e18) > ?`;

export class AssetService {
  constructor(private readonly db: Db) {}

  createBranch(input: { id: string; name: string }): void {
    run(this.db, 'INSERT INTO branches (id, name) VALUES (?, ?)', [input.id, input.name]);
  }

  createCabinet(input: { id: string; branchId: string; name: string }): void {
    if (!get(this.db, 'SELECT 1 FROM branches WHERE id = ?', [input.branchId])) {
      throw new NotFoundError('分院', input.branchId);
    }
    run(this.db, 'INSERT INTO cabinets (id, branch_id, name) VALUES (?, ?, ?)', [
      input.id,
      input.branchId,
      input.name,
    ]);
  }

  createDevice(input: { id: string; model?: string | undefined }, now: number): void {
    run(this.db, 'INSERT INTO devices (id, model, created_at) VALUES (?, ?, ?)', [
      input.id,
      input.model ?? null,
      now,
    ]);
  }

  deviceExists(deviceId: string): boolean {
    return get(this.db, 'SELECT 1 FROM devices WHERE id = ?', [deviceId]) !== undefined;
  }

  /** 建立綁定 [from, to)，同一裝置與同一冷藏櫃的綁定期間都不可重疊 */
  bindDevice(deviceId: string, cabinetId: string, from: number, to: number | null = null): void {
    if (!this.deviceExists(deviceId)) throw new NotFoundError('溫度計', deviceId);
    if (!get(this.db, 'SELECT 1 FROM cabinets WHERE id = ?', [cabinetId])) {
      throw new NotFoundError('冷藏櫃', cabinetId);
    }
    if (
      get(this.db, `SELECT 1 FROM bindings WHERE device_id = ? AND ${OVERLAP_SQL}`, [
        deviceId,
        to,
        from,
      ])
    ) {
      throw new DomainError('BINDING_CONFLICT', `裝置 ${deviceId} 在該期間已綁定其他冷藏櫃`, 409);
    }
    if (
      get(this.db, `SELECT 1 FROM bindings WHERE cabinet_id = ? AND ${OVERLAP_SQL}`, [
        cabinetId,
        to,
        from,
      ])
    ) {
      throw new DomainError('BINDING_CONFLICT', `冷藏櫃 ${cabinetId} 在該期間已綁定其他裝置`, 409);
    }
    run(
      this.db,
      'INSERT INTO bindings (device_id, cabinet_id, bound_from, bound_to) VALUES (?, ?, ?, ?)',
      [deviceId, cabinetId, from, to],
    );
  }

  /**
   * 更換溫度計：結束目前綁定，新裝置自 at 起綁定。
   * 綁定只能往未來修改，確保已寫入的量測資料歸屬不會改變。
   */
  replaceDevice(cabinetId: string, newDeviceId: string, at: number): void {
    transaction(this.db, () => {
      const current = get<BindingRow>(
        this.db,
        'SELECT * FROM bindings WHERE cabinet_id = ? AND bound_to IS NULL',
        [cabinetId],
      );
      if (current) {
        if (current.device_id === newDeviceId) {
          throw new DomainError('SAME_DEVICE', '新裝置與目前綁定的裝置相同');
        }
        const last = get<{ t: number | null }>(
          this.db,
          'SELECT MAX(measured_at) AS t FROM readings WHERE cabinet_id = ?',
          [cabinetId],
        );
        const floor = Math.max(current.bound_from + 1, (last?.t ?? 0) + 1);
        if (at < floor) {
          throw new DomainError(
            'REPLACEMENT_IN_PAST',
            '更換時間不可早於該冷藏櫃已收到的最後一筆資料',
          );
        }
        run(this.db, 'UPDATE bindings SET bound_to = ? WHERE id = ?', [at, current.id]);
      }
      this.bindDevice(newDeviceId, cabinetId, at);
    });
  }

  resolveCabinet(deviceId: string, measuredAt: number): string | null {
    const row = get<{ cabinet_id: string }>(
      this.db,
      `SELECT cabinet_id FROM bindings
       WHERE device_id = ? AND bound_from <= ? AND (bound_to IS NULL OR bound_to > ?)`,
      [deviceId, measuredAt, measuredAt],
    );
    return row?.cabinet_id ?? null;
  }

  listBindings(cabinetId: string): BindingDto[] {
    return all<BindingRow>(
      this.db,
      'SELECT * FROM bindings WHERE cabinet_id = ? ORDER BY bound_from',
      [cabinetId],
    ).map(toBindingDto);
  }

  listAllBindings(): BindingDto[] {
    return all<BindingRow>(this.db, 'SELECT * FROM bindings ORDER BY cabinet_id, bound_from').map(
      toBindingDto,
    );
  }
}
