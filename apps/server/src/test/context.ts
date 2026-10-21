import { FixedClock } from '../infra/clock';
import type { Db } from '../infra/db';
import { EventRepository } from '../modules/events/event-repository';
import { ExcursionReconciler } from '../modules/events/excursion-reconciler';
import { IngestionService } from '../modules/ingestion/ingestion-service';
import { ReadingPipeline } from '../modules/ingestion/reading-pipeline';
import { NotificationService } from '../modules/notifications/notification-service';
import { seedBasicAssets } from './fixtures';
import { createTestDb, T0 } from './helpers';

/** 組好接收 → 判定 → 通知整條流程，供整合測試使用 */
export function createTestContext() {
  const db: Db = createTestDb();
  const clock = new FixedClock(T0);
  const assets = seedBasicAssets(db);
  const events = new EventRepository(db);
  const notifications = new NotificationService(db);
  const excursions = new ExcursionReconciler(db, events, notifications, assets);
  const ingestion = new IngestionService(db, assets);
  const pipeline = new ReadingPipeline(db, clock, ingestion, excursions);
  return { db, clock, assets, events, notifications, excursions, ingestion, pipeline };
}
