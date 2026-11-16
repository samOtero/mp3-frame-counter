import multipart from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import { countMp3Frames, Mp3ParseError } from "../mp3/count-frames.js";
import { countMp3FramesStream } from "../mp3/count-frames-stream.js";
import { processUploadedFile, readUploadedFile, UploadError } from "../uploads/read-uploaded-file.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const fileUploadRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
  });

  app.post("/file-upload", async (request, reply) => {
    try {
      const file = await readUploadedFile(request);
      return { frameCount: countMp3Frames(file) };
    } catch (error) {
      if (error instanceof UploadError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof Mp3ParseError) {
        return reply.code(400).send({ error: error.message });
      }

      // Let Fastify log and handle unexpected failures instead of hiding them.
      throw error;
    }
  });
  app.post("/file-upload-stream", async (request, reply) => {
    try {
      const frameCount = await processUploadedFile(request, countMp3FramesStream);
      return { frameCount };
    } catch (error) {
      if (error instanceof UploadError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof Mp3ParseError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });
};
