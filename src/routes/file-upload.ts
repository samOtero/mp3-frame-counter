import type { FastifyPluginAsync } from 'fastify';

export const fileUploadRoutes: FastifyPluginAsync = async (app) => {
  app.post('/file-upload', async () => {
    // Temporary response until file upload handling and MP3 parsing are added.
    return { frameCount: 1234 };
  });
};
