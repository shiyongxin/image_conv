/**
 * Entry point — starts the Fastify server and listens on the configured port.
 *
 * Run with `npm run dev` (tsx watch) or `npm start` (after `npm run build`).
 */

import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT) || 3028;
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

void main();
