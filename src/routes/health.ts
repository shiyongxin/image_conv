/**
 * GET /health
 *
 * Lightweight liveness probe. Returns service status and uptime.
 */

import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));
}
