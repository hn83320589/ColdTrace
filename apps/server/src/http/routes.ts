import type { FastifyInstance } from 'fastify';
import {
  createBranchSchema,
  createCabinetSchema,
  createDeviceSchema,
  deviceReplacementSchema,
  dispositionInputSchema,
  ingestRequestSchema,
  type ClockInfo,
} from '@coldtrace/shared';
import { z } from 'zod';
import { all } from '../infra/db';
import { NotFoundError } from '../infra/errors';
import type { Services } from '../services';
import { idParam, numericIdParam, parse, timeValue } from './validation';

const rangeQuery = z.object({ from: timeValue.optional(), to: timeValue.optional() });

const eventQuery = z.object({
  type: z.enum(['EXCURSION', 'OFFLINE']).optional(),
  status: z.string().optional(),
  cabinetId: z.string().optional(),
  from: timeValue.optional(),
  to: timeValue.optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export function registerRoutes(app: FastifyInstance, s: Services): void {
  // ---------- 量測接收 ----------
  app.post('/api/readings/batch', (req) => {
    const body = parse(ingestRequestSchema, req.body);
    const result = s.pipeline.process(body.readings);
    for (const c of result.conflicts) {
      req.log.warn(c, '流水號重複但內容不同，已保留原始紀錄');
    }
    s.publish(result.messages);
    return result.response;
  });

  // ---------- 儀表板 ----------
  app.get('/api/dashboard', () => s.dashboard.snapshot(s.clock.now()));

  app.get('/api/cabinets/:id/readings', (req) => {
    const { id } = parse(idParam, req.params);
    const query = parse(rangeQuery, req.query);
    const fallback = s.dashboard.defaultRange(s.clock.now());
    const from = query.from ?? fallback.from;
    const to = query.to ?? fallback.to;
    return { cabinetId: id, from, to, points: s.dashboard.readings(id, from, to) };
  });

  // ---------- 主檔 ----------
  app.get('/api/branches', () => all(s.db, 'SELECT id, name FROM branches ORDER BY id'));

  app.post('/api/branches', (req, reply) => {
    s.assets.createBranch(parse(createBranchSchema, req.body));
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/cabinets', () =>
    all(
      s.db,
      `SELECT c.id, c.name, c.branch_id AS branchId, b.name AS branchName
       FROM cabinets c JOIN branches b ON b.id = c.branch_id ORDER BY c.id`,
    ),
  );

  app.post('/api/cabinets', (req, reply) => {
    s.assets.createCabinet(parse(createCabinetSchema, req.body));
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/devices', () =>
    all(
      s.db,
      `SELECT d.id, d.model,
         (SELECT MAX(seq) FROM readings r WHERE r.device_id = d.id) AS lastSeq,
         (SELECT cabinet_id FROM bindings b WHERE b.device_id = d.id AND b.bound_to IS NULL) AS cabinetId
       FROM devices d ORDER BY d.id`,
    ),
  );

  app.post('/api/devices', (req, reply) => {
    s.assets.createDevice(parse(createDeviceSchema, req.body), s.clock.now());
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/bindings', () => s.assets.listAllBindings());

  app.get('/api/cabinets/:id/bindings', (req) => {
    const { id } = parse(idParam, req.params);
    return s.assets.listBindings(id);
  });

  app.post('/api/cabinets/:id/device-replacement', (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(deviceReplacementSchema, req.body);
    const at = body.at ? Date.parse(body.at) : s.clock.now();
    s.assets.replaceDevice(id, body.newDeviceId, at);
    const cabinet = s.dashboard.cabinet(id, s.clock.now());
    if (cabinet) s.bus.publish([{ type: 'cabinet.status', cabinet }]);
    return s.assets.listBindings(id);
  });

  // ---------- 事件 ----------
  app.get('/api/events', (req) => s.eventQueries.list(parse(eventQuery, req.query), s.clock.now()));

  app.get('/api/events/:id', (req) => {
    const { id } = parse(numericIdParam, req.params);
    return s.eventQueries.detail(id, s.clock.now());
  });

  app.post('/api/events/:id/dispositions', (req, reply) => {
    const { id } = parse(numericIdParam, req.params);
    const input = parse(dispositionInputSchema, req.body);
    const { detail, messages } = s.eventQueries.addDisposition(id, input, s.clock.now());
    s.bus.publish(messages);
    return reply.code(201).send(detail);
  });

  // ---------- 通知 ----------
  app.get('/api/notifications', (req) => {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
      req.query,
    );
    return s.notifications.list(limit);
  });

  // ---------- 月報 ----------
  const monthQuery = z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式應為 YYYY-MM'),
  });

  app.get('/api/reports/monthly', (req) => {
    const { month } = parse(monthQuery, req.query);
    return s.reports.monthly(month, s.clock.now());
  });

  app.get('/api/reports/monthly.csv', (req, reply) => {
    const { month, kind } = parse(
      monthQuery.extend({ kind: z.enum(['summary', 'events']).default('summary') }),
      req.query,
    );
    const report = s.reports.monthly(month, s.clock.now());
    const csv = kind === 'summary' ? s.reports.summaryCsv(report) : s.reports.eventsCsv(report);
    const filename = `ColdTrace月報_${month}_${kind === 'summary' ? '摘要' : '事件清單'}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(csv);
  });

  // ---------- 系統 ----------
  app.get('/api/system/clock', (): ClockInfo => ({ now: s.clock.now(), speed: s.clock.speed }));

  app.get('/api/*', () => {
    throw new NotFoundError('API', 'path');
  });
}
