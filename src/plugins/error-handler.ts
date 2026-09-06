/**
 * Centralized Fastify error handler.
 *
 * Maps our domain errors (UnsupportedFormatError, InvalidOptionsError,
 * ImageProcessingError) and Fastify validation errors to consistent
 * RFC 7807-style JSON responses. Unknown errors get a generic 500.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UnsupportedFormatError } from "../config/formats.js";
import { ImageProcessingError, InvalidOptionsError } from "../services/converter.js";
import type { ApiErrorBody } from "../types.js";

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // 1. Multipart library errors (file too large, unexpected field, etc.)
    if (isMultipartError(err)) {
      const status = err.statusCode ?? 400;
      const body: ApiErrorBody = {
        type: `https://api.example.com/errors/multipart-${slug(err.code ?? "error")}`,
        title: "Multipart upload error",
        status,
        detail: err.message,
        instance: request.url,
      };
      reply.status(status).send(body);
      return;
    }

    // 2. Fastify schema validation errors (FST_ERR_VALIDATION).
    if (err.validation) {
      const status = err.statusCode ?? 400;
      const body: ApiErrorBody = {
        type: "https://api.example.com/errors/validation",
        title: "Request validation failed",
        status,
        detail: err.message,
        instance: request.url,
        invalidParams: err.validation.map((v) => ({
          name: String(v.instancePath || v.params?.missingProperty || "body"),
          reason: v.message ?? "invalid value",
        })),
      };
      reply.status(status).send(body);
      return;
    }

    // 3. Domain errors.
    if (err instanceof UnsupportedFormatError) {
      const body: ApiErrorBody = {
        type: "https://api.example.com/errors/unsupported-format",
        title: "Unsupported output format",
        status: 415,
        detail: err.message,
        instance: request.url,
      };
      reply.status(415).send(body);
      return;
    }

    if (err instanceof InvalidOptionsError) {
      const body: ApiErrorBody = {
        type: "https://api.example.com/errors/invalid-options",
        title: "Invalid conversion options",
        status: 400,
        detail: err.message,
        instance: request.url,
      };
      reply.status(400).send(body);
      return;
    }

    if (err instanceof ImageProcessingError) {
      const body: ApiErrorBody = {
        type: "https://api.example.com/errors/image-processing",
        title: "Image processing failed",
        status: 422,
        detail: err.message,
        instance: request.url,
      };
      reply.status(422).send(body);
      return;
    }

    // 4. Request-shape errors thrown by route handlers.
    if (err.name === "BadRequestError") {
      const body: ApiErrorBody = {
        type: "https://api.example.com/errors/bad-request",
        title: "Bad request",
        status: 400,
        detail: err.message,
        instance: request.url,
      };
      reply.status(400).send(body);
      return;
    }

    if (err.name === "UnsupportedContentTypeError") {
      const body: ApiErrorBody = {
        type: "https://api.example.com/errors/unsupported-content-type",
        title: "Unsupported Content-Type",
        status: 415,
        detail: err.message,
        instance: request.url,
      };
      reply.status(415).send(body);
      return;
    }

    // 5. Anything else — log it and return a generic 500.
    request.log.error({ err }, "unhandled error");
    const body: ApiErrorBody = {
      type: "https://api.example.com/errors/internal",
      title: "Internal server error",
      status: 500,
      detail: "An unexpected error occurred while processing the request.",
      instance: request.url,
    };
    reply.status(500).send(body);
  });
}

function isMultipartError(err: FastifyError): boolean {
  // @fastify/multipart sets the error name to a stable identifier and exposes
  // a `code` property (e.g. "FST_REQ_FILE_TOO_LARGE", "FST_FILES_LIMIT").
  const code = err.code ?? "";
  return code.startsWith("FST_") && /FILE|MULTIPART|FORM|UPLOAD/i.test(code + err.name);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
