/**
 * 黑箱驗收測試：只透過 HTTP API 與 WebSocket 操作一台執行中的伺服器，逐條驗證驗收標準。
 *
 * 用法：
 *   CLOCK_SPEED=60 COLDTRACE_DB=/tmp/acceptance.db PORT=3200 npm start -w @coldtrace/server
 *   npm run acceptance -- http://localhost:3200
 *
 * 建議以 CLOCK_SPEED=60 執行，「停止送資料 15 分鐘」只需約 15 秒。
 * 每次執行都會建立獨立的分院、冷藏櫃與溫度計，可對同一台伺服器重複執行。
 */
import {
  HOUR_MS,
  MINUTE_MS,
  type BranchDashboard,
  type ClockInfo,
  type EventDto,
  type IngestResponse,
  type MonthlyReport,
  type NotificationDto,
  type ReadingInput,
  type ReadingPoint,
  type WsMessage,
} from '@coldtrace/shared';

const API = (process.argv[2] ?? 'http://localhost:3200').replace(/\/$/, '');
const RUN = Date.now().toString(36).slice(-5).toUpperCase();

// ---------- HTTP ----------

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body: unknown) => request<T>('POST', path, body);
const upload = (readings: ReadingInput[]) =>
  post<IngestResponse>('/api/readings/batch', { readings });

const serverNow = () => clock.now + (Date.now() - fetchedAt) * clock.speed;
const minuteFloor = (t: number) => Math.floor(t / MINUTE_MS) * MINUTE_MS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await sleep(250);
  }
  throw new Error(`逾時：${what}`);
}

// ---------- 測試資料 ----------

/** 建立一台冷藏櫃與溫度計，自 boundFrom 起綁定 */
async function createCabinet(
  name: string,
  boundFrom: number,
): Promise<{ cabinetId: string; deviceId: string }> {
  const cabinetId = `ZT-${RUN}-${name}`;
  const deviceId = `ZD-${RUN}-${name}`;
  await post('/api/cabinets', { id: cabinetId, branchId: `ZB-${RUN}`, name: `驗收櫃 ${name}` });
  await post('/api/devices', { id: deviceId, model: 'ACCEPTANCE' });
  await post(`/api/cabinets/${cabinetId}/device-replacement`, {
    newDeviceId: deviceId,
    at: new Date(boundFrom).toISOString(),
  });
  return { cabinetId, deviceId };
}

function series(deviceId: string, start: number, temps: number[], firstSeq = 1): ReadingInput[] {
  return temps.map((temperature, i) => ({
    deviceId,
    seq: firstSeq + i,
    measuredAt: new Date(start + i * MINUTE_MS).toISOString(),
    temperature,
    battery: 90,
  }));
}
const repeat = (v: number, n: number) => Array<number>(n).fill(v);

const eventsOf = (cabinetId: string, type?: 'EXCURSION' | 'OFFLINE') =>
  get<EventDto[]>(`/api/events?cabinetId=${cabinetId}${type ? `&type=${type}` : ''}`);
const readingsOf = (cabinetId: string, from: number, to: number) =>
  get<{ points: ReadingPoint[] }>(`/api/cabinets/${cabinetId}/readings?from=${from}&to=${to}`).then(
    (r) => r.points,
  );

// ---------- 驗收項目 ----------

interface Result {
  id: string;
  title: string;
  pass: boolean;
  evidence: string;
}
const results: Result[] = [];

async function check(id: string, title: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const evidence = await fn();
    results.push({ id, title, pass: true, evidence });
    console.log(`✅ #${id} ${title}（${Date.now() - started} ms）\n   ${evidence}`);
  } catch (error) {
    results.push({ id, title, pass: false, evidence: (error as Error).message });
    console.log(`❌ #${id} ${title}\n   ${(error as Error).message}`);
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const clock = await get<ClockInfo>('/api/system/clock');
const fetchedAt = Date.now();
console.log(`驗收對象 ${API}（時鐘倍率 ×${clock.speed}），本次批號 ${RUN}\n`);
await post('/api/branches', { id: `ZB-${RUN}`, name: `驗收分院 ${RUN}` });

// WebSocket：記錄所有推播，供 #7、#10 檢查
const wsMessages: WsMessage[] = [];
const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws`);
ws.onmessage = (e: { data: unknown }) => wsMessages.push(JSON.parse(String(e.data)) as WsMessage);
await waitFor('WebSocket 連線', () =>
  Promise.resolve(ws.readyState === WebSocket.OPEN ? true : undefined),
);

await check('1', '範例資料：8 間分院、16 台冷藏櫃、≥ 7 天歷史', async () => {
  const dashboard = await get<BranchDashboard[]>('/api/dashboard');
  const seeded = dashboard.filter((b) => !b.branchId.startsWith('ZB-'));
  const cabinets = seeded.flatMap((b) => b.cabinets);
  expect(seeded.length === 8, `分院數 ${seeded.length}`);
  expect(cabinets.length === 16, `冷藏櫃數 ${cabinets.length}`);
  const now = serverNow();
  const points = await readingsOf('C01', now - 8 * 24 * HOUR_MS, now);
  const spanDays = (points.at(-1)![0] - points[0]![0]) / (24 * HOUR_MS);
  expect(spanDays >= 6.99, `C01 歷史跨度僅 ${spanDays.toFixed(2)} 天`);
  return `8 間分院、16 台冷藏櫃；C01 歷史 ${points.length} 筆，跨度 ${spanDays.toFixed(2)} 天`;
});

const base = minuteFloor(serverNow()) - 3 * HOUR_MS;

await check('2', '同一批資料重送 3 次，資料筆數不變', async () => {
  const { cabinetId, deviceId } = await createCabinet('R', base);
  const batch = series(deviceId, base, repeat(4.5, 60));
  const first = await upload(batch);
  const resends = [await upload(batch), await upload(batch), await upload(batch)];
  const points = await readingsOf(cabinetId, base, base + HOUR_MS);
  expect(first.accepted === 60, `首次接受 ${first.accepted}`);
  expect(
    resends.every((r) => r.accepted === 0 && r.duplicated === 60),
    '重送仍有寫入',
  );
  expect(points.length === 60, `資料筆數 ${points.length}`);
  return `首次接受 60；重送 3 次皆為 accepted=0、duplicated=60；資料庫仍為 60 筆`;
});

await check('3', '75 小時前的資料拒收，回應列出筆數與流水號', async () => {
  const { deviceId } = await createCabinet('OLD', serverNow() - 80 * HOUR_MS);
  const old = series(deviceId, serverNow() - 75 * HOUR_MS, [4.0, 4.1, 4.2], 101);
  const fresh = series(deviceId, minuteFloor(serverNow()) - 5 * MINUTE_MS, [4.5], 500);
  const res = await upload([...old, ...fresh]);
  expect(res.rejectedCount === 3, `拒收 ${res.rejectedCount} 筆`);
  expect(
    JSON.stringify(res.rejected.map((r) => [r.seq, r.reason])) ===
      JSON.stringify([
        [101, 'TOO_OLD'],
        [102, 'TOO_OLD'],
        [103, 'TOO_OLD'],
      ]),
    `拒收明細 ${JSON.stringify(res.rejected)}`,
  );
  expect(res.accepted === 1, `正常資料應接受 1 筆，實際 ${res.accepted}`);
  return `rejectedCount=3，rejected=${JSON.stringify(res.rejected)}；同批 1 筆新資料正常接受`;
});

let tenMinuteEvent: EventDto | undefined;
let tenMinuteBatch: ReadingInput[] = [];

await check('4', '超標 9 分鐘不產生事件；超標 10 分鐘產生事件', async () => {
  const nine = await createCabinet('N9', base);
  await upload(series(nine.deviceId, base, [5, 5, ...repeat(9.5, 9), 5, 5]));
  const nineEvents = await eventsOf(nine.cabinetId, 'EXCURSION');

  const ten = await createCabinet('N10', base);
  tenMinuteBatch = series(ten.deviceId, base, [5, 5, ...repeat(9.5, 10), 5, 5]);
  await upload(tenMinuteBatch);
  const tenEvents = await eventsOf(ten.cabinetId, 'EXCURSION');
  tenMinuteEvent = tenEvents[0];

  expect(nineEvents.length === 0, `9 分鐘產生了 ${nineEvents.length} 個事件`);
  expect(tenEvents.length === 1, `10 分鐘產生 ${tenEvents.length} 個事件`);
  expect(tenMinuteEvent?.durationMs === 10 * MINUTE_MS, `持續 ${tenMinuteEvent?.durationMs}`);
  expect(tenMinuteEvent?.startedAt === base + 2 * MINUTE_MS, '開始時間錯誤');
  expect(tenMinuteEvent?.endedAt === base + 12 * MINUTE_MS, '結束時間錯誤');
  return `9 分鐘：0 個事件；10 分鐘：1 個事件 #${tenMinuteEvent!.id}，持續 10 分鐘，起訖時間正確`;
});

await check('5', '累積超標度分鐘與手算一致', async () => {
  const { cabinetId, deviceId } = await createCabinet('DM', base);
  // 超出量 0.5+1.0+1.5+2.0+2.0+1.5+1.0+0.5+0.2+0.1 = 10.3 度分鐘
  const temps = [8.5, 9.0, 9.5, 10.0, 10.0, 9.5, 9.0, 8.5, 8.2, 8.1];
  await upload(series(deviceId, base, [5, ...temps, 5]));
  const [event] = await eventsOf(cabinetId, 'EXCURSION');
  expect(event?.degreeMinutesX10 === 103, `度分鐘 ${event?.degreeMinutesX10 ?? '無事件'}`);
  expect(event?.maxTempX10 === 100 && event.minTempX10 === 81, '極值錯誤');
  return `手算 0.5+1.0+1.5+2.0+2.0+1.5+1.0+0.5+0.2+0.1 = 10.3；系統 ${event!.degreeMinutesX10! / 10}，最高 10.0°C、最低 8.1°C`;
});

await check('6', '更換溫度計後，新舊溫度計資料歸屬到正確的冷藏櫃', async () => {
  const { cabinetId, deviceId: oldDevice } = await createCabinet('SW', base);
  const newDevice = `ZD-${RUN}-SW-NEW`;
  await post('/api/devices', { id: newDevice });
  await upload(series(oldDevice, base, repeat(4.1, 30))); // base … base+29
  const swapAt = base + 31 * MINUTE_MS;
  await post(`/api/cabinets/${cabinetId}/device-replacement`, {
    newDeviceId: newDevice,
    at: new Date(swapAt).toISOString(),
  });
  // 新溫度計上傳；舊溫度計延遲補傳更換前一筆，並誤送更換後一筆
  const fromNew = await upload(series(newDevice, swapAt, repeat(4.6, 20)));
  const lateOld = await upload(series(oldDevice, base + 30 * MINUTE_MS, [4.2, 4.3], 31));
  const points = await readingsOf(cabinetId, base, base + 2 * HOUR_MS);
  expect(fromNew.accepted === 20, `新溫度計接受 ${fromNew.accepted}`);
  expect(
    lateOld.accepted === 1 && lateOld.rejected[0]?.reason === 'UNBOUND',
    `舊溫度計補傳 ${JSON.stringify(lateOld)}`,
  );
  expect(points.length === 51, `冷藏櫃資料 ${points.length} 筆`);
  return `舊溫度計 31 筆（含更換後才補傳的 1 筆）＋新溫度計 20 筆 = 51 筆，皆歸屬 ${cabinetId}；舊溫度計更換後時段的資料以 UNBOUND 拒收`;
});

await check('9', '同一事件不論重送或補傳，「事件成立」通知只有一則', async () => {
  expect(tenMinuteEvent !== undefined, '依賴 #4 的事件');
  for (let i = 0; i < 3; i++) await upload(tenMinuteBatch);
  await upload([...tenMinuteBatch].reverse().slice(0, 7));
  await upload(tenMinuteBatch.slice(7));
  const notifications = await get<NotificationDto[]>('/api/notifications?limit=500');
  const mine = notifications.filter((n) => n.eventId === tenMinuteEvent!.id);
  const started = mine.filter((n) => n.kind === 'EXCURSION_STARTED').length;
  const ended = mine.filter((n) => n.kind === 'EXCURSION_ENDED').length;
  const events = await eventsOf(tenMinuteEvent!.cabinetId, 'EXCURSION');
  expect(events.length === 1, `事件數 ${events.length}`);
  expect(started === 1, `成立通知 ${started} 則`);
  expect(ended === 1, `結束通知 ${ended} 則`);
  return `重送 3 次 + 亂序分批重送後：事件 1 個，成立通知 ${started} 則、結束通知 ${ended} 則`;
});

await check('7', '停止送資料 15 分鐘後產生斷線事件，儀表板顯示斷線', async () => {
  const now = minuteFloor(serverNow());
  const { cabinetId, deviceId } = await createCabinet('OFF', now - 5 * MINUTE_MS);
  await upload(series(deviceId, now - MINUTE_MS, [4.5]));
  const lastAt = now - MINUTE_MS;

  const event = await waitFor(
    '斷線事件',
    async () => (await eventsOf(cabinetId, 'OFFLINE'))[0],
    120_000,
  );
  const delayMin = (event.detectedAt - lastAt) / MINUTE_MS;
  const dashboard = await get<BranchDashboard[]>('/api/dashboard');
  const status = dashboard
    .flatMap((b) => b.cabinets)
    .find((c) => c.cabinetId === cabinetId)?.status;
  const pushed = wsMessages.some(
    (m) =>
      m.type === 'cabinet.status' &&
      m.cabinet.cabinetId === cabinetId &&
      m.cabinet.status === 'OFFLINE',
  );
  expect(delayMin > 15 && delayMin <= 16, `最後資料後 ${delayMin.toFixed(2)} 分鐘才偵測`);
  expect(event.startedAt === lastAt + MINUTE_MS, '斷線開始時間錯誤');
  expect(status === 'OFFLINE', `儀表板狀態 ${status}`);
  expect(pushed, 'WebSocket 未推播斷線狀態');
  return `最後一筆資料後 ${delayMin.toFixed(2)} 分鐘（模擬時間）偵測到斷線 #${event.id}；儀表板 status=OFFLINE，WebSocket 已推播`;
});

await check(
  '8',
  '斷線 2 小時後補傳且含 30 分鐘超標：事件時間正確、相互關聯、圖表連續',
  async () => {
    const now = minuteFloor(serverNow());
    const start = now - 200 * MINUTE_MS;
    const { cabinetId, deviceId } = await createCabinet('BF', start);
    await upload(series(deviceId, start, repeat(4.5, 50))); // 最後一筆在 start+49
    const offlineFrom = start + 50 * MINUTE_MS;
    await waitFor('斷線事件', async () => (await eventsOf(cabinetId, 'OFFLINE'))[0]);

    // 斷線期間 120 分鐘的緩衝：第 40 分鐘起超標 30 分鐘；恢復時先送即時資料再補傳
    const until = minuteFloor(serverNow());
    const count = (until - offlineFrom) / MINUTE_MS + 1;
    const temps = Array.from({ length: count }, (_, i) => (i >= 40 && i < 70 ? 9.6 : 4.5));
    const buffered = series(deviceId, offlineFrom, temps, 51);
    await upload(buffered.slice(-1));
    for (let i = 0; i < buffered.length - 1; i += 50)
      await upload(buffered.slice(i, Math.min(i + 50, buffered.length - 1)));

    // 綁定後、第一批資料送達前，掃描可能已先成立斷線事件（開始於綁定時間），兩者皆為正確行為
    const offlineEvents = await eventsOf(cabinetId, 'OFFLINE');
    const offline = offlineEvents[0];
    const excursions = await eventsOf(cabinetId, 'EXCURSION');
    const excursion = excursions[0];
    const points = await readingsOf(cabinetId, start, until);
    const maxStepMin = Math.max(
      ...points.slice(1).map((p, i) => (p[0] - points[i]![0]) / MINUTE_MS),
    );

    expect(offlineEvents.length === 1, `斷線事件 ${offlineEvents.length} 個`);
    expect(offline?.status === 'BACKFILLED_EXCURSION', `斷線狀態 ${offline?.status}`);
    expect(excursions.length === 1, `異常事件 ${excursions.length} 個`);
    expect(excursion?.startedAt === offlineFrom + 40 * MINUTE_MS, '異常開始時間錯誤');
    expect(excursion?.endedAt === offlineFrom + 70 * MINUTE_MS, '異常結束時間錯誤');
    expect(excursion?.durationMs === 30 * MINUTE_MS, `異常持續 ${excursion?.durationMs}`);
    expect(
      offline!.linkedEventIds.includes(excursion!.id) &&
        excursion!.linkedEventIds.includes(offline!.id),
      '未互相關聯',
    );
    expect(maxStepMin === 1, `圖表最大間隔 ${maxStepMin} 分鐘`);
    return `斷線 #${offline!.id}（${Math.round((offline!.endedAt! - offline!.startedAt) / MINUTE_MS)} 分鐘）→ BACKFILLED_EXCURSION；異常 #${excursion!.id} 恰為斷線後第 40–70 分鐘、30 分鐘；雙向關聯；補傳後序列相鄰點間隔皆為 1 分鐘（圖表連續）`;
  },
);

await check('10', '狀態推播：正常 → 異常 → 正常（WebSocket）', async () => {
  const now = minuteFloor(serverNow());
  // 綁定時間貼近第一筆資料，避免斷線掃描先判定為斷線
  const { cabinetId, deviceId } = await createCabinet('LIVE', now - 14 * MINUTE_MS);
  const sent: ReadingInput[] = series(deviceId, now - 13 * MINUTE_MS, [
    4.5,
    ...repeat(9.5, 10),
    4.5,
  ]);
  for (const reading of sent) await upload([reading]); // 逐筆送，模擬即時回報
  const statuses = wsMessages
    .filter(
      (m): m is Extract<WsMessage, { type: 'cabinet.status' }> =>
        m.type === 'cabinet.status' && m.cabinet.cabinetId === cabinetId,
    )
    .map((m) => m.cabinet.status)
    .filter((s, i, all) => i === 0 || s !== all[i - 1]);
  expect(
    JSON.stringify(statuses) === JSON.stringify(['NORMAL', 'ALERT', 'NORMAL']),
    `推播序列 ${statuses.join(' → ')}`,
  );
  return `WebSocket 推播的狀態序列：${statuses.join(' → ')}（畫面端另以瀏覽器驗證）`;
});

await check('11', '24 小時圖表資料量（1,440 點）', async () => {
  // 時鐘持續前進，以 C02 最後一筆資料為基準取 24 小時
  const dashboard = await get<BranchDashboard[]>('/api/dashboard');
  const last = dashboard
    .flatMap((b) => b.cabinets)
    .find((c) => c.cabinetId === 'C02')?.lastReportedAt;
  expect(typeof last === 'number', 'C02 沒有資料');
  const points = await readingsOf('C02', last! - 24 * HOUR_MS + MINUTE_MS, last!);
  expect(points.length === 1440, `24 小時內 ${points.length} 點`);
  return `C02 最後 24 小時恰為 ${points.length} 點（繪製時間另以瀏覽器量測）`;
});

await check('12', '月報合規率、資料完整率與手算一致；CSV 中文不亂碼', async () => {
  const month = new Date(serverNow() + 8 * HOUR_MS).toISOString().slice(0, 7);
  const report = await get<MonthlyReport>(`/api/reports/monthly?month=${month}`);
  const dm = report.cabinets.find((c) => c.cabinetId === `ZT-${RUN}-DM`);
  expect(dm !== undefined, '月報缺少驗收櫃');
  // 手算：12 筆資料（1 正常 + 10 超標 + 1 正常）→ 範圍內 2 筆
  const until = minuteFloor(report.generatedAt);
  const expectedMinutes = Math.floor((until - base) / MINUTE_MS);
  expect(
    dm!.recordedMinutes === 12 && dm!.inRangeMinutes === 2,
    `有資料 ${dm!.recordedMinutes}、範圍內 ${dm!.inRangeMinutes}`,
  );
  expect(
    Math.abs(dm!.expectedMinutes - expectedMinutes) <= 1,
    `應有分鐘 ${dm!.expectedMinutes} vs 手算 ${expectedMinutes}`,
  );
  expect(Math.abs(dm!.complianceRate! - 2 / 12) < 1e-12, `合規率 ${dm!.complianceRate}`);
  expect(
    Math.abs(dm!.completenessRate! - 12 / dm!.expectedMinutes) < 1e-12,
    `完整率 ${dm!.completenessRate}`,
  );

  const res = await fetch(`${API}/api/reports/monthly.csv?month=${month}&kind=summary`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  expect(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, '缺少 UTF-8 BOM');
  expect(
    text.includes('\r\n') && text.includes('溫度合規率(%)') && text.includes('台北分院'),
    'CSV 內容不完整',
  );
  expect(
    res.headers.get('content-type')?.includes('charset=utf-8') ?? false,
    'Content-Type 缺少 charset',
  );
  return `驗收櫃：有資料 12、範圍內 2 → 合規率 ${((2 / 12) * 100).toFixed(2)}%；完整率 12/${dm!.expectedMinutes}；CSV 以 EF BB BF 開頭、CRLF、可嚴格 UTF-8 解碼`;
});

ws.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n結果：${passed}/${results.length} 項通過`);
console.log(`RESULT_JSON=${JSON.stringify(results)}`);
process.exit(passed === results.length ? 0 : 1);
