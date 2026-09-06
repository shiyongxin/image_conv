/**
 * Fastify application factory.
 *
 * Exports buildApp() which returns a fully configured Fastify instance.
 * Keeping this separate from the entry point lets us inject a custom
 * configuration in tests (e.g. lower max file size) and instantiate the
 * app without binding to a port.
 */

import "dotenv/config";
import fastifyMultipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_MAX_FILE_SIZE } from "./config/formats.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { convertRoutes } from "./routes/convert.js";
import { formatsRoutes } from "./routes/formats.js";
import { healthRoutes } from "./routes/health.js";

export interface AppOptions {
  /** Override the multipart upload size limit (bytes). */
  maxFileSize?: number;
  /** Disable the default logger (useful for tests). */
  logger?: boolean | object;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const fileSizeLimit = options.maxFileSize ?? (Number(process.env.MAX_FILE_SIZE) || DEFAULT_MAX_FILE_SIZE);

  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
    },
    bodyLimit: fileSizeLimit,
  });

  await registerErrorHandler(app);

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: fileSizeLimit,
      files: 1,
      fields: 10,
      fieldSize: 1024,
    },
  });

  await app.register(formatsRoutes);
  await app.register(convertRoutes);
  await app.register(healthRoutes);

  return app;
}
