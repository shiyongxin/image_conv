/**
 * GET /v1/formats
 *
 * Returns the supported input MIME types, output formats (with their
 * available options), and limits. Useful for clients (like n8n) to
 * discover what's available before submitting a conversion request.
 */

import type { FastifyInstance } from "fastify";
import {
  DEFAULT_MAX_FILE_SIZE,
  MAX_HEIGHT,
  MAX_WIDTH,
  OUTPUT_FORMATS,
  SUPPORTED_INPUT_MIMES,
} from "../config/formats.js";

export async function formatsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/formats", async () => {
    const outputs = Object.entries(OUTPUT_FORMATS).map(([key, info]) => ({
      key,
      mime: info.mime,
      extension: info.extension,
      options: info.options,
    }));

    return {
      inputs: SUPPORTED_INPUT_MIMES,
      outputs,
      limits: {
        maxFileSize: Number(process.env.MAX_FILE_SIZE) || DEFAULT_MAX_FILE_SIZE,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
      },
      notes: [
        "WebP is supported as INPUT only — Jimp has no WebP encoder.",
        "AVIF is supported via a custom WebAssembly plugin (slower than the bundled formats).",
        "When converting to JPEG, any alpha channel is flattened onto the background color (default #ffffff).",
      ],
    };
  });
}
