/**
 * POST /v1/convert
 *
 * Converts an image to the requested output format. The request shape is
 * selected automatically by Content-Type, with extra n8n-friendly affordances:
 *
 *   1. multipart/form-data — typical browser/n8n file upload
 *      Fields: file (or "data" or "image"), format (required), quality,
 *              deflateLevel, width, height, background
 *
 *   2. application/json — base64-in-JSON, convenient for programmatic clients
 *      Body: { image: "<base64 | data:URL>", format: "<key>", options?: {...} }
 *
 * Format can also come from:
 *   - The ?format=jpeg query parameter (useful when the body is multipart)
 *   - The Accept header (e.g. "Accept: image/jpeg" — first image/* wins)
 *
 * Output shape can be controlled via:
 *   - ?response=base64 → return JSON { mime, data, input, output } instead of
 *     raw binary. Convenient for n8n workflows that want to chain the
 *     converted image through other JSON-only nodes.
 *
 * On success (binary mode): returns the encoded bytes with Content-Type and
 * Content-Disposition headers so callers (and n8n) can save it directly.
 * The detected input format is exposed via X-Input-Mime / X-Input-* headers.
 * On failure, the central error handler returns an RFC 7807 JSON envelope.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { mimeToFormatKey } from "../config/formats.js";
import { convertImage, type ConvertOptions } from "../services/converter.js";
import type { JsonConvertRequest } from "../types.js";

/**
 * Multipart field names accepted for the uploaded binary file, in priority
 * order. n8n's HTTP Request node uses the Binary Property name (default "data")
 * but we also accept "file" and "image" for browser/mobile clients.
 */
const FILE_FIELD_NAMES = ["file", "data", "image"] as const;

interface ConvertQuery {
  format?: string;
  response?: "base64" | "binary";
}

export async function convertRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/convert", async (request, reply) => {
    const { buffer, options, outputFormat, sourceName } = await extractInput(request);
    const query = request.query as ConvertQuery;

    const result = await convertImage({
      buffer,
      outputFormat,
      options,
    });

    // ────────────────────────────────────────────────────────────────────────
    // Response headers — always set, regardless of body shape.
    // ────────────────────────────────────────────────────────────────────────
    reply.header("X-Input-Mime", result.inputMime);
    reply.header("X-Input-Width", String(result.sourceWidth));
    reply.header("X-Input-Height", String(result.sourceHeight));
    reply.header("X-Output-Mime", result.mime);
    reply.header("X-Output-Width", String(result.outputWidth));
    reply.header("X-Output-Height", String(result.outputHeight));

    // ────────────────────────────────────────────────────────────────────────
    // Base64 JSON response mode — for clients that want the image wrapped
    // in a JSON envelope rather than as raw binary.
    // ────────────────────────────────────────────────────────────────────────
    if (query.response === "base64") {
      return reply.send({
        mime: result.mime,
        extension: result.extension,
        data: result.buffer.toString("base64"),
        input: {
          mime: result.inputMime,
          width: result.sourceWidth,
          height: result.sourceHeight,
        },
        output: {
          width: result.outputWidth,
          height: result.outputHeight,
        },
      });
    }

    // ────────────────────────────────────────────────────────────────────────
    // Default: raw binary response.
    // ────────────────────────────────────────────────────────────────────────
    const filename = buildFilename(sourceName, result.extension);
    reply
      .header("Content-Type", result.mime)
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(result.buffer);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Request shape extraction
// ────────────────────────────────────────────────────────────────────────────

interface ExtractedInput {
  buffer: Buffer;
  /** Resolved target format (after merging query/Accept/body sources). */
  outputFormat: string;
  options: ConvertOptions;
  /** Original filename (if any) used to build the response filename. */
  sourceName?: string;
}

interface PartialInput {
  buffer: Buffer;
  /** Format hint as it appeared in the request body (may be undefined). */
  bodyFormat?: string;
  options: ConvertOptions;
  sourceName?: string;
}

async function extractInput(request: FastifyRequest): Promise<ExtractedInput> {
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();

  let partial: PartialInput;

  if (contentType.startsWith("multipart/form-data")) {
    partial = await extractFromMultipart(request);
  } else if (contentType.startsWith("application/json")) {
    partial = extractFromJson(request);
  } else {
    throw new UnsupportedContentTypeError(
      `Unsupported Content-Type '${contentType}'. Use multipart/form-data or application/json.`
    );
  }

  // Merge in conversion options from the query string (overrides body values
  // — query params are explicit). Format is resolved separately below.
  const queryOptions = extractOptionsFromQuery(request);
  const options: ConvertOptions = { ...partial.options, ...queryOptions };

  // Output format is resolved in priority order:
  //   1. ?format= query parameter (cleanest for n8n URL-driven calls)
  //   2. Accept header (HTTP-native content negotiation, first image/* wins)
  //   3. Format field in multipart/JSON body
  const formatFromQueryOrHeader = resolveFormatFromRequest(request);
  const outputFormat = formatFromQueryOrHeader ?? partial.bodyFormat ?? "";

  if (!outputFormat) {
    throw new BadRequestError(
      "Missing output format. Provide it via ?format=jpeg, an Accept: image/* header, or a 'format' field in the body."
    );
  }

  return { buffer: partial.buffer, options, sourceName: partial.sourceName, outputFormat };
}

/**
 * Look at query string and Accept header for an output format hint.
 *
 * Returns a value compatible with `resolveOutputFormat` — i.e. a format
 * KEY like "jpeg", not a MIME like "image/jpeg". When the source is the
 * Accept header (which gives a MIME), we convert via `mimeToFormatKey`.
 *
 * Returns undefined if neither is present or the value isn't supported.
 */
function resolveFormatFromRequest(request: FastifyRequest): string | undefined {
  const query = request.query as ConvertQuery;
  if (query.format && typeof query.format === "string") {
    return query.format.trim();
  }
  const accept = request.headers.accept;
  if (typeof accept === "string") {
    const match = accept.match(/image\/[a-zA-Z0-9.+-]+/);
    if (match) {
      // Prefer the format key (e.g. "jpeg") but fall back to the MIME if
      // somehow we don't know it — the downstream resolver will produce a
      // proper 415 if it's unsupported.
      return mimeToFormatKey(match[0]) ?? match[0];
    }
  }
  return undefined;
}

/**
 * Read conversion options (quality, width, height, deflateLevel, background)
 * from the query string. Anything not present is left undefined.
 */
function extractOptionsFromQuery(request: FastifyRequest): ConvertOptions {
  const q = request.query as Record<string, unknown>;
  const opts: ConvertOptions = {};
  if (typeof q.quality === "string") opts.quality = parsePositiveInt(q.quality, "quality");
  if (typeof q.deflateLevel === "string") opts.deflateLevel = parsePositiveInt(q.deflateLevel, "deflateLevel");
  if (typeof q.width === "string") opts.width = parsePositiveInt(q.width, "width");
  if (typeof q.height === "string") opts.height = parsePositiveInt(q.height, "height");
  if (typeof q.background === "string") opts.background = q.background;
  return opts;
}

async function extractFromMultipart(request: FastifyRequest): Promise<PartialInput> {
  if (!request.isMultipart()) {
    throw new BadRequestError("Request declared multipart/form-data but no parts were found.");
  }

  let buffer: Buffer | undefined;
  let sourceName: string | undefined;
  let bodyFormat: string | undefined;
  const options: ConvertOptions = {};

  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      if (!FILE_FIELD_NAMES.includes(part.fieldname as (typeof FILE_FIELD_NAMES)[number])) {
        // Drain unexpected file fields so the stream doesn't block.
        await part.toBuffer();
        continue;
      }
      buffer = await part.toBuffer();
      sourceName = part.filename;
    } else if (part.type === "field") {
      switch (part.fieldname) {
        case "format":
          bodyFormat = String(part.value);
          break;
        case "quality":
          options.quality = parsePositiveInt(part.value, "quality");
          break;
        case "deflateLevel":
          options.deflateLevel = parsePositiveInt(part.value, "deflateLevel");
          break;
        case "width":
          options.width = parsePositiveInt(part.value, "width");
          break;
        case "height":
          options.height = parsePositiveInt(part.value, "height");
          break;
        case "background":
          options.background = String(part.value);
          break;
      }
    }
  }

  if (!buffer) {
    throw new BadRequestError(
      `Missing required file field. Expected one of: ${FILE_FIELD_NAMES.join(", ")}.`
    );
  }

  return { buffer, bodyFormat, options, sourceName };
}

function extractFromJson(request: FastifyRequest): PartialInput {
  const body = request.body as Partial<JsonConvertRequest> | undefined;
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body must be a JSON object.");
  }
  if (typeof body.image !== "string" || body.image.length === 0) {
    throw new BadRequestError("Field 'image' is required and must be a base64 string or data URL.");
  }

  let buffer: Buffer;
  try {
    buffer = decodeBase64Image(body.image);
  } catch (err) {
    throw new BadRequestError(
      `Field 'image' is not valid base64: ${(err as Error).message}`
    );
  }

  return {
    buffer,
    bodyFormat: body.format,
    options: body.options ?? {},
    sourceName: undefined,
  };
}

/**
 * Accept either a raw base64 string or a "data:image/...;base64,XXX" URL.
 * Returns the decoded bytes.
 */
function decodeBase64Image(value: string): Buffer {
  const dataUrlMatch = /^data:[^;]+;base64,(.+)$/.exec(value);
  const b64 = dataUrlMatch ? dataUrlMatch[1]! : value;
  return Buffer.from(b64, "base64");
}

function parsePositiveInt(raw: unknown, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestError(`Field '${name}' must be a positive integer, got '${String(raw)}'.`);
  }
  return n;
}

// ────────────────────────────────────────────────────────────────────────────
// Local error classes — converted to HTTP responses by the central handler
// ────────────────────────────────────────────────────────────────────────────

class UnsupportedContentTypeError extends Error {
  override readonly name = "UnsupportedContentTypeError";
}

class BadRequestError extends Error {
  override readonly name = "BadRequestError";
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function buildFilename(sourceName: string | undefined, ext: string): string {
  if (sourceName) {
    // Strip any existing extension and replace with the new one.
    const stem = sourceName.replace(/\.[^.]+$/, "");
    const safe = stem.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return `${safe}.${ext}`;
  }
  return `converted.${ext}`;
}
