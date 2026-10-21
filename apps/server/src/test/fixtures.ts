import { MINUTE_MS, type ReadingInput } from '@coldtrace/shared';
import type { Db } from '../infra/db';
import { AssetService } from '../modules/assets/asset-service';
import { T0 } from './helpers';

/** 一間分院、兩台冷藏櫃 C01/C02，分別綁定 TM-01/TM-02（自 T0 − 4 天起） */
export function seedBasicAssets(db: Db): AssetService {
  const assets = new AssetService(db);
  assets.createBranch({ id: 'B01', name: '台北分院' });
  for (const n of ['01', '02']) {
    assets.createCabinet({ id: `C${n}`, branchId: 'B01', name: `冷藏櫃 ${n}` });
    assets.createDevice({ id: `TM-${n}` }, T0);
    assets.bindDevice(`TM-${n}`, `C${n}`, T0 - 4 * 24 * 60 * MINUTE_MS);
  }
  return assets;
}

/** 由溫度序列產生每分鐘一筆的量測 */
export function series(
  deviceId: string,
  start: number,
  temps: number[],
  firstSeq = 1,
): ReadingInput[] {
  return temps.map((temperature, i) => ({
    deviceId,
    seq: firstSeq + i,
    measuredAt: new Date(start + i * MINUTE_MS).toISOString(),
    temperature,
    battery: 90,
  }));
}

export const repeat = (value: number, times: number): number[] => Array<number>(times).fill(value);
