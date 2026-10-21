import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WsMessage } from '@coldtrace/shared';
import { DomainError } from '../infra/errors';
import type { Services } from '../services';
import { registerRoutes } from './routes';

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  /** 前端 build 結果的目錄，存在時由後端一併提供 */
  webRoot?: string | undefined;
}

export async function buildApp(
  services: Services,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ code: 'BAD_REQUEST', message: (error as Error).message });
    }
    req.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '伺服器內部錯誤' });
  });

  await app.register(websocket);
  await app.register((scope, _opts, done) => {
    scope.get('/ws', { websocket: true }, (socket) => {
      const send = (message: WsMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };
      send({ type: 'snapshot', branches: services.dashboard.snapshot(services.clock.now()) });
      const unsubscribe = services.bus.subscribe(send);
      socket.on('close', unsubscribe);
    });
    done();
  });

  registerRoutes(app, services);

  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot });
    app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
  }

  return app;
}
