import { beforeEach, describe, expect, it } from 'vitest';
import { MINUTE_MS } from '@coldtrace/shared';
import type { Db } from '../../infra/db';
import { run } from '../../infra/db';
import { createTestDb, T0 } from '../../test/helpers';
import { AssetService } from './asset-service';

describe('AssetService', () => {
  let db: Db;
  let assets: AssetService;

  beforeEach(() => {
    db = createTestDb();
    assets = new AssetService(db);
    assets.createBranch({ id: 'B01', name: '台北分院' });
    assets.createCabinet({ id: 'C01', branchId: 'B01', name: '冷藏櫃 A' });
    assets.createCabinet({ id: 'C02', branchId: 'B01', name: '冷藏櫃 B' });
    assets.createDevice({ id: 'TM-OLD' }, T0);
    assets.createDevice({ id: 'TM-NEW' }, T0);
    assets.bindDevice('TM-OLD', 'C01', T0);
  });

  it('依量測時間解析到綁定中的冷藏櫃', () => {
    expect(assets.resolveCabinet('TM-OLD', T0 + MINUTE_MS)).toBe('C01');
    expect(assets.resolveCabinet('TM-OLD', T0 - 1)).toBeNull();
    expect(assets.resolveCabinet('TM-NEW', T0 + MINUTE_MS)).toBeNull();
  });

  it('更換溫度計後，新舊裝置依量測時間各自歸屬（半開區間）', () => {
    const swapAt = T0 + 60 * MINUTE_MS;
    assets.replaceDevice('C01', 'TM-NEW', swapAt);

    expect(assets.resolveCabinet('TM-OLD', swapAt - 1)).toBe('C01');
    expect(assets.resolveCabinet('TM-OLD', swapAt)).toBeNull();
    expect(assets.resolveCabinet('TM-NEW', swapAt)).toBe('C01');
    expect(assets.resolveCabinet('TM-NEW', swapAt - 1)).toBeNull();
    expect(assets.listBindings('C01').map((b) => [b.deviceId, b.boundTo])).toEqual([
      ['TM-OLD', swapAt],
      ['TM-NEW', null],
    ]);
  });

  it('同一支裝置不可同時綁定兩台冷藏櫃', () => {
    expect(() => assets.bindDevice('TM-OLD', 'C02', T0 + MINUTE_MS)).toThrow(/裝置.*已綁定/);
  });

  it('同一台冷藏櫃不可同時綁定兩支裝置', () => {
    expect(() => assets.bindDevice('TM-NEW', 'C01', T0 + MINUTE_MS)).toThrow(/冷藏櫃.*已綁定/);
  });

  it('更換時間不可早於已收到的最後一筆資料（不改寫歷史歸屬）', () => {
    run(
      db,
      `INSERT INTO readings (device_id, seq, cabinet_id, measured_at, temp_x10, battery, received_at)
       VALUES ('TM-OLD', 1, 'C01', ?, 45, 90, ?)`,
      [T0 + 30 * MINUTE_MS, T0 + 30 * MINUTE_MS],
    );
    expect(() => assets.replaceDevice('C01', 'TM-NEW', T0 + 10 * MINUTE_MS)).toThrow(/不可早於/);
  });

  it('更換失敗時不留下半套綁定', () => {
    assets.bindDevice('TM-NEW', 'C02', T0);
    expect(() => assets.replaceDevice('C01', 'TM-NEW', T0 + MINUTE_MS)).toThrow();
    expect(assets.listBindings('C01')[0]?.boundTo).toBeNull();
  });
});
