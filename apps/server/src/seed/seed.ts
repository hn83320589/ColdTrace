import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  TemperatureModel,
  createRng,
  type DispositionInput,
  type ReadingInput,
} from '@coldtrace/shared';
import { FixedClock } from '../infra/clock';
import { all, get, type Db } from '../infra/db';
import { createServices } from '../services';

export const BRANCHES = [
  ['B01', '台北分院'],
  ['B02', '新北分院'],
  ['B03', '桃園分院'],
  ['B04', '新竹分院'],
  ['B05', '台中分院'],
  ['B06', '嘉義分院'],
  ['B07', '台南分院'],
  ['B08', '高雄分院'],
] as const;

const STEP_MS = 5 * MINUTE_MS;
const SEED = 20261021;

export const deviceIdOf = (n: number) => `TM-${String(n).padStart(4, '0')}`;
export const cabinetIdOf = (n: number) => `C${String(n).padStart(2, '0')}`;

/** 裝置斷線期間：資料先存在本機，恢復後補傳（lost 表示資料遺失、不補傳） */
interface Outage {
  cabinet: string;
  from: number;
  to: number;
  lost?: boolean;
}

export function isEmpty(db: Db): boolean {
  return (get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM branches')?.n ?? 0) === 0;
}

/**
 * 產生範例資料：8 間分院 × 2 台冷藏櫃、7 天每分鐘一筆。
 * 以 FixedClock 從 7 天前逐步推進，資料走與正式環境相同的接收與判定流程，
 * 因此事件、斷線、補傳的結果都與系統規則一致。
 */
export function seedSampleData(db: Db, realNow: number, days = 7) {
  const now = Math.floor(realNow / MINUTE_MS) * MINUTE_MS;
  const start = now - days * DAY_MS;
  const clock = new FixedClock(start);
  const s = createServices(db, clock);
  const rng = createRng(SEED);
  const dayAt = (day: number, hour: number, minute = 0) =>
    start + day * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS;

  // ---------- 主檔 ----------
  const bindFrom = start - DAY_MS;
  BRANCHES.forEach(([id, name], i) => {
    s.assets.createBranch({ id, name });
    for (const [k, label] of [
      [1, 'A'],
      [2, 'B'],
    ] as const) {
      const n = i * 2 + k;
      s.assets.createCabinet({ id: cabinetIdOf(n), branchId: id, name: `疫苗冷藏櫃 ${label}` });
      s.assets.createDevice({ id: deviceIdOf(n), model: 'TM-200' }, bindFrom);
    }
  });
  for (let n = 17; n <= 20; n++)
    s.assets.createDevice({ id: deviceIdOf(n), model: 'TM-200' }, bindFrom);
  const replacedDevice = deviceIdOf(105);
  s.assets.createDevice({ id: replacedDevice, model: 'TM-100' }, bindFrom);

  const cabinets = Array.from({ length: 16 }, (_, i) => cabinetIdOf(i + 1));
  const deviceFor = new Map<string, string>(cabinets.map((c, i) => [c, deviceIdOf(i + 1)]));
  deviceFor.set('C05', replacedDevice); // C05 原本裝舊型溫度計，第 4 天更換
  for (const [cabinet, device] of deviceFor) s.assets.bindDevice(device, cabinet, bindFrom);
  const replacement = { cabinet: 'C05', device: deviceIdOf(5), at: dayAt(4, 10) };

  // ---------- 溫度模型與預埋情境 ----------
  const models = new Map(
    cabinets.map((c) => [c, new TemperatureModel(createRng(SEED + c.charCodeAt(2)), 4 + rng())]),
  );
  for (const model of models.values()) {
    for (let day = 0; day < days; day++) {
      const doors = 2 + Math.floor(rng() * 3); // 每天開門 2–4 次（看診時間）
      for (let k = 0; k < doors; k++) {
        model.addIncident({
          kind: 'door-open',
          start: dayAt(day, 9 + Math.floor(rng() * 9), Math.floor(rng() * 60)),
          durationMin: 3 + Math.floor(rng() * 4),
          peak: 7 + rng() * 2.5,
        });
      }
    }
  }
  models
    .get('C03')
    ?.addIncident({ kind: 'compressor-failure', start: dayAt(2, 14), durationMin: 110, peak: 11 });
  models.get('C12')?.addIncident({ kind: 'freeze', start: dayAt(5, 3), durationMin: 40, low: 0.8 });
  models
    .get('C10')
    ?.addIncident({ kind: 'plateau', start: dayAt(5, 21, 30), durationMin: 30, value: 9.6 });

  const outages: Outage[] = [
    { cabinet: 'C07', from: dayAt(3, 22), to: dayAt(4, 0) }, // 週末斷電 2 小時，補傳正常
    { cabinet: 'C10', from: dayAt(5, 21), to: dayAt(5, 23) }, // 斷線 2 小時，補傳含 30 分鐘超標
    { cabinet: 'C14', from: dayAt(6, 2), to: dayAt(6, 2, 40), lost: true }, // 資料遺失
  ];

  // ---------- 依時間推進，模擬裝置上傳 ----------
  const seqOf = new Map<string, number>();
  const buffers = new Map<string, ReadingInput[]>();
  let readingCount = 0;

  for (let t = start; t <= now; t += STEP_MS) {
    if (t >= replacement.at && deviceFor.get(replacement.cabinet) !== replacement.device) {
      s.assets.replaceDevice(replacement.cabinet, replacement.device, replacement.at);
      deviceFor.set(replacement.cabinet, replacement.device);
    }

    const batch: ReadingInput[] = [];
    /** 恢復連線時的第一筆即時資料，先單獨送出（與真實裝置行為一致） */
    const reconnects: ReadingInput[] = [];
    for (const cabinet of cabinets) {
      const device = deviceFor.get(cabinet)!;
      const model = models.get(cabinet)!;
      for (let m = t; m < Math.min(t + STEP_MS, now + 1); m += MINUTE_MS) {
        const seq = (seqOf.get(device) ?? 0) + 1;
        seqOf.set(device, seq);
        const reading: ReadingInput = {
          deviceId: device,
          seq,
          measuredAt: new Date(m).toISOString(),
          temperature: model.sample(m),
          battery: Math.max(20, 100 - Math.floor((m - start) / (8 * HOUR_MS))),
        };
        const outage = outages.find((o) => o.cabinet === cabinet && m >= o.from && m < o.to);
        if (!outage) batch.push(reading);
        else if (!outage.lost) buffers.set(cabinet, [...(buffers.get(cabinet) ?? []), reading]);
      }
      // 恢復連線：先送即時資料，再補傳緩衝資料
      const ended = outages.find((o) => o.cabinet === cabinet && o.to > t - STEP_MS && o.to <= t);
      if (ended) {
        const firstLive = batch.findIndex((r) => r.deviceId === device);
        if (firstLive >= 0) reconnects.push(...batch.splice(firstLive, 1));
        batch.push(...(buffers.get(cabinet) ?? []));
        buffers.delete(cabinet);
      }
    }

    for (const reading of reconnects) {
      clock.set(Date.parse(reading.measuredAt) + 10_000);
      readingCount += s.pipeline.process([reading]).response.accepted;
    }
    clock.set(Math.min(t + STEP_MS, now) + 10_000);
    for (let i = 0; i < batch.length; i += 1000) {
      readingCount += s.pipeline.process(batch.slice(i, i + 1000)).response.accepted;
    }
    s.offline.scan(clock.now());
  }

  // ---------- 處置紀錄 ----------
  const dispositionFor: Record<string, DispositionInput> = {
    C03: {
      handler: '王護理師',
      note: '壓縮機故障，疫苗已移至備用冷藏櫃，已聯絡廠商維修。依仿單評估溫度暴露時間，部分疫苗報廢。',
      vaccineDiscarded: true,
      discardedQty: 24,
    },
    C12: {
      handler: '李藥師',
      note: '溫控器設定錯誤導致過冷，已重新設定。疫苗經評估可繼續使用。',
      vaccineDiscarded: false,
      discardedQty: 0,
    },
  };
  const excursions = all<{ id: number; cabinet_id: string }>(
    db,
    `SELECT id, cabinet_id FROM events WHERE type = 'EXCURSION' AND status = 'CLOSED'`,
  );
  for (const e of excursions) {
    const input = dispositionFor[e.cabinet_id];
    if (input) s.eventQueries.addDisposition(e.id, input, now);
  }

  const count = (sql: string) => get<{ n: number }>(db, sql)?.n ?? 0;
  return {
    readings: readingCount,
    excursions: count(
      `SELECT COUNT(*) AS n FROM events WHERE type = 'EXCURSION' AND status != 'MERGED'`,
    ),
    offlineEvents: count(`SELECT COUNT(*) AS n FROM events WHERE type = 'OFFLINE'`),
  };
}
