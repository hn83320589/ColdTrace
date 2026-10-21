import type { Clock } from './infra/clock';
import type { Db } from './infra/db';
import { AssetService } from './modules/assets/asset-service';
import { DashboardService } from './modules/dashboard/dashboard-service';
import { EventQueryService } from './modules/events/event-query-service';
import { EventRepository } from './modules/events/event-repository';
import { ExcursionReconciler } from './modules/events/excursion-reconciler';
import { OfflineService } from './modules/events/offline-service';
import { IngestionService } from './modules/ingestion/ingestion-service';
import { ReadingPipeline } from './modules/ingestion/reading-pipeline';
import { NotificationService } from './modules/notifications/notification-service';
import { EventBus } from './realtime/event-bus';

/** 組裝所有 service（手動依賴注入，測試可替換 db 與 clock） */
export function createServices(db: Db, clock: Clock) {
  const assets = new AssetService(db);
  const events = new EventRepository(db);
  const notifications = new NotificationService(db);
  const excursions = new ExcursionReconciler(db, events, notifications, assets);
  const offline = new OfflineService(db, events, notifications, assets);
  const ingestion = new IngestionService(db, assets);
  const pipeline = new ReadingPipeline(db, clock, ingestion, excursions, [offline]);
  const dashboard = new DashboardService(db);
  const eventQueries = new EventQueryService(db, events);
  const bus = new EventBus();

  return {
    db,
    clock,
    bus,
    assets,
    events,
    notifications,
    offline,
    pipeline,
    dashboard,
    eventQueries,
    /** 推播 domain messages，並補上受影響冷藏櫃的狀態 */
    publish(messages: Parameters<EventBus['publish']>[0]): void {
      if (messages.length === 0) return;
      bus.publish(dashboard.withStatusUpdates([...messages], clock.now()));
    },
  };
}

export type Services = ReturnType<typeof createServices>;
