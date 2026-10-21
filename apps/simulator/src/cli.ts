import { parseArgs } from 'node:util';
import {
  MINUTE_MS,
  BACKFILL_WINDOW_MS,
  type ClockInfo,
  type EventDto,
  type IngestResponse,
  type ReadingInput,
} from '@coldtrace/shared';
import { SimulatedDevice } from './device';
import { buildPlan, isScenario, SCENARIOS, type ScenarioName } from './scenarios';
import { verifyScenario } from './verify';

const HELP = `用法：npm run simulator -- [選項]

  --scenario <名稱>         所有裝置的情境（預設 normal）：${SCENARIOS.join(' | ')}
  --override <裝置=情境>     個別裝置情境，可重複，例如 --override TM-0003=door-open
  --duration <時間>          模擬時間長度，例如 30m、2h；省略則持續執行（Ctrl+C 結束）
  --incident-after <時間>    情境開始前的正常時間（預設 2m）
  --devices <數量>           只模擬前 N 支已綁定的裝置（預設全部）
  --api <網址>               後端位址（預設 http://localhost:3000）

時間倍率由伺服器決定：以 CLOCK_SPEED=60 啟動後端，模擬器會自動以 60 倍速執行。`;

function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(text);
  if (!match) throw new Error(`時間格式錯誤：${text}（例如 30m、2h）`);
  const unit = { s: 1000, m: MINUTE_MS, h: 60 * MINUTE_MS }[match[2] as 's' | 'm' | 'h'];
  return Number(match[1]) * unit;
}

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'normal' },
    override: { type: 'string', multiple: true, default: [] },
    duration: { type: 'string' },
    'incident-after': { type: 'string', default: '2m' },
    devices: { type: 'string' },
    api: { type: 'string', default: process.env.COLDTRACE_API ?? 'http://localhost:3000' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const api = values.api.replace(/\/$/, '');
const defaultScenario = values.scenario;
if (!isScenario(defaultScenario)) throw new Error(`未知情境：${defaultScenario}\n\n${HELP}`);
const overrides = new Map<string, ScenarioName>(
  values.override.map((o) => {
    const [device, scenario] = o.split('=');
    if (!device || !scenario || !isScenario(scenario)) throw new Error(`--override 格式錯誤：${o}`);
    return [device, scenario];
  }),
);

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${api}${path}`);
  if (!res.ok) throw new Error(`${path} 回應 ${res.status}`);
  return (await res.json()) as T;
}

let uploadErrors = 0;
async function upload(readings: ReadingInput[]): Promise<IngestResponse> {
  const res = await fetch(`${api}/api/readings/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ readings }),
  });
  if (!res.ok) {
    uploadErrors++;
    throw new Error(`上傳失敗 ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as IngestResponse;
}

/** 後端還沒起來時持續重試（npm run dev 會同時啟動） */
async function waitForServer(): Promise<ClockInfo> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getJson<ClockInfo>('/api/system/clock');
    } catch {
      if (attempt % 10 === 1) console.log(`等待後端啟動（${api}）…`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

interface DeviceInfo {
  id: string;
  lastSeq: number | null;
  lastMeasuredAt: number | null;
  cabinetId: string | null;
}

const clock = await waitForServer();
const fetchedAt = Date.now();
const serverNow = () => clock.now + (Date.now() - fetchedAt) * clock.speed;

const bound = (await getJson<DeviceInfo[]>('/api/devices')).filter((d) => d.cabinetId !== null);
const selected = values.devices ? bound.slice(0, Number(values.devices)) : bound;
const startedAt = Math.floor(serverNow() / MINUTE_MS) * MINUTE_MS;
const incidentAt = startedAt + parseDuration(values['incident-after']);
const durationMs = values.duration ? parseDuration(values.duration) : null;
const horizon = startedAt + (durationMs ?? 7 * 24 * 60 * MINUTE_MS);

const devices = selected.map((d, i) => {
  const scenario = overrides.get(d.id) ?? defaultScenario;
  // 從裝置最後一筆之後接續；中間空白（例如昨天關機）在 72 小時內的部分會補傳
  const resumeFrom = Math.max(
    (d.lastMeasuredAt ?? startedAt - MINUTE_MS) + MINUTE_MS,
    startedAt - BACKFILL_WINDOW_MS + 10 * MINUTE_MS,
  );
  const plan = buildPlan(scenario, 1000 + i, incidentAt, horizon);
  return {
    scenario,
    cabinetId: d.cabinetId!,
    device: new SimulatedDevice(d.id, d.lastSeq ?? 0, resumeFrom, plan),
  };
});

console.log(
  `模擬 ${devices.length} 支溫度計，時鐘倍率 ×${clock.speed}，情境：` +
    [...new Set(devices.map((d) => d.scenario))]
      .map((s) => `${s}(${devices.filter((d) => d.scenario === s).length})`)
      .join('、'),
);
for (const d of devices.filter((x) => x.scenario !== 'normal')) {
  console.log(`  ${d.device.id} → ${d.cabinetId}：${d.scenario}`);
}

const tickMs = Math.max(200, Math.min(5000, MINUTE_MS / clock.speed / 2));
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});

while (!stopping) {
  const now = serverNow();
  await Promise.all(devices.map((d) => d.device.tick(now, upload)));
  if (durationMs !== null && now - startedAt >= durationMs) break;
  await new Promise((r) => setTimeout(r, tickMs));
}

// ---------- 結果摘要與情境驗證 ----------
const elapsedMin = Math.floor((serverNow() - incidentAt) / MINUTE_MS);
const events = await getJson<EventDto[]>(`/api/events?from=${startedAt}&limit=2000`);
const total = devices.reduce(
  (acc, d) => ({
    sent: acc.sent + d.device.stats.sent,
    accepted: acc.accepted + d.device.stats.accepted,
    duplicated: acc.duplicated + d.device.stats.duplicated,
    rejected: acc.rejected + d.device.stats.rejected,
  }),
  { sent: 0, accepted: 0, duplicated: 0, rejected: 0 },
);
console.log(
  `\n上傳 ${total.sent} 筆：接受 ${total.accepted}、重複 ${total.duplicated}、拒收 ${total.rejected}；上傳錯誤 ${uploadErrors} 次`,
);
console.log(`情境開始後經過 ${elapsedMin} 分鐘（模擬時間），事件判定結果：`);

let failures = 0;
for (const d of devices) {
  const own = events.filter((e) => e.cabinetId === d.cabinetId && e.startedAt >= startedAt);
  const verdict = verifyScenario(d.scenario, own, elapsedMin);
  if (!verdict.ok) failures++;
  const mark = !verdict.ok ? '❌' : verdict.pending ? '⏳' : '✅';
  console.log(`  ${mark} ${d.device.id}（${d.cabinetId}，${d.scenario}）：${verdict.detail}`);
}
process.exit(failures > 0 || uploadErrors > 0 ? 1 : 0);
