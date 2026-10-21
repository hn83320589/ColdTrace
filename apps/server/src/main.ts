import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScaledClock, SystemClock, type Clock } from './infra/clock';
import { openDb } from './infra/db';
import { migrate } from './infra/migrate';
import { buildApp } from './http/app';
import { startOfflineMonitor } from './realtime/offline-monitor';
import { startRetentionJob } from './realtime/retention';
import { isEmpty, seedSampleData } from './seed/seed';
import { createServices } from './services';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(process.env.COLDTRACE_DB ?? resolve(here, '../../../data/coldtrace.db'));
const port = Number(process.env.PORT ?? 3000);
const speed = Number(process.env.CLOCK_SPEED ?? 1);

const clock: Clock = speed === 1 ? new SystemClock() : new ScaledClock(speed);

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
migrate(db, clock.now());

const services = createServices(db, clock);
const app = await buildApp(services, {
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  webRoot: resolve(here, '../../web/dist'),
});

if (isEmpty(db)) {
  app.log.info('資料庫為空，產生範例資料（8 間分院、16 台冷藏櫃、7 天歷史）…');
  const summary = seedSampleData(db, clock.now());
  app.log.info(summary, '範例資料產生完成');
}

const stopMonitor = startOfflineMonitor(
  clock,
  (now) => services.publish(services.offline.scan(now)),
  (error) => app.log.error(error, '斷線掃描失敗'),
);
const stopRetention = startRetentionJob(db, clock, (error) =>
  app.log.error(error, '資料保存清理失敗'),
);

const shutdown = async () => {
  stopMonitor();
  stopRetention();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port, host: '0.0.0.0' });
app.log.info(`ColdTrace 後端已啟動：http://localhost:${port}（時鐘倍率 ${clock.speed}x）`);
