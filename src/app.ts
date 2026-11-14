import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import { fileUploadRoutes } from './routes/file-upload.js';

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify({ logger: true, ...options });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.register(fileUploadRoutes);

  return app;
}
