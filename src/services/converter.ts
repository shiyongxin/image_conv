/**
 * Framework-agnostic image conversion service.
 *
 * Uses sharp (native libvips bindings) to decode/transform/encode images.
 */

import sharp from "sharp";
import type { Metadata, Sharp } from "sharp";
import {
  DEFAULT_DEFLATE_LEVEL,
  DEFAULT_JPEG_BACKGROUND,
  DEFAULT_QUALITY,
  MAX_HEIGHT,
  MAX_WIDTH,
  resolveOutputFormat,
} from "../config/formats.js";

type SharpMetadata = Metadata;

function hexToSharpColor(hex: string): { r: number; g: number; b: number } {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function applyResize(
  pipeline: Sharp,
  width?: number,
  height?: number,
): Sharp {
  if (width !== undefined && height !== undefined) {
    return pipeline.resize({ width, height, fit: "fill" });
  } else if (width !== undefined) {
    return pipeline.resize({ width, fit: "inside" });
  } else if (height !== undefined) {
    return pipeline.resize({ height, fit: "inside" });
  }
  return pipeline;
}

function applyOutputFormat(
  pipeline: Sharp,
  mime: string,
  opts: NormalizedOptions,
): Sharp {
  switch (mime) {
    case "image/jpeg":
      return pipeline.jpeg({ quality: opts.quality });
    case "image/png":
      return pipeline.png({ compressionLevel: opts.deflateLevel });
    case "image/webp":
      return pipeline.webp({ quality: opts.quality });
    case "image/avif":
      // sharp uses higher = better (it maps to libavif quality internally)
      return pipeline.avif({ quality: opts.quality });
    case "image/tiff":
      return pipeline.tiff({ quality: opts.quality });

    case "image/gif":
      return pipeline.gif();
    default:
      return pipeline;
  }
}

export interface ConvertOptions {
  /** JPEG/TIFF quality 1-100. Defaults to DEFAULT_QUALITY. */
  quality?: number;
  /** PNG deflate level 0-9. Defaults to DEFAULT_DEFLATE_LEVEL. */
  deflateLevel?: number;
  /** Target width in pixels. Requires either width or height, or both. */
  width?: number;
  /** Target height in pixels. Requires either width or height, or both. */
  height?: number;
  /**
   * Hex color string (e.g. "#ffffff") used as background when flattening
   * alpha for JPEG output. Defaults to DEFAULT_JPEG_BACKGROUND.
   */
  background?: string;
}

export interface ConvertInput {
  /** Raw image bytes (decoded from upload or base64). */
  buffer: Buffer;
  /** Target output format identifier (e.g. "jpeg", "png"). */
  outputFormat: string;
  /** Optional transformation parameters. */
  options?: ConvertOptions;
}

export interface ConvertResult {
  /** The encoded image bytes ready to send to the client. */
  buffer: Buffer;
  /** MIME type of the encoded output. */
  mime: string;
  /** File extension (no leading dot) for Content-Disposition. */
  extension: string;
  /** Detected MIME type of the source image (auto-detected by sharp from bytes). */
  inputMime: string;
  /** Source image width in pixels. */
  sourceWidth: number;
  /** Source image height in pixels. */
  sourceHeight: number;
  /** Output image width in pixels (after resize if applied). */
  outputWidth: number;
  /** Output image height in pixels (after resize if applied). */
  outputHeight: number;
}

/** Errors thrown by convertImage that callers should map to HTTP responses. */
export class ImageProcessingError extends Error {
  override readonly name = "ImageProcessingError";
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export class InvalidOptionsError extends Error {
  override readonly name = "InvalidOptionsError";
}

export class ImageTooLargeError extends Error {
  override readonly name = "ImageTooLargeError";
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert an image buffer from any supported input format to the requested
 * output format, optionally resizing and tuning quality/compression.
 *
 * Throws:
 *  - UnsupportedFormatError (re-exported from config) — unknown output format
 *  - ImageProcessingError — decode/encode failure, corrupt input, oversize
 *  - InvalidOptionsError — bad resize/quality ranges
 */
export async function convertImage(input: ConvertInput): Promise<ConvertResult> {
  const format = resolveOutputFormat(input.outputFormat);
  const opts = normalizeOptions(input.options);

  let pipeline = sharp(input.buffer);
  let metadata: SharpMetadata;
  try {
    metadata = await pipeline.metadata();
  } catch (err) {
    throw new ImageProcessingError(
      "Failed to decode input image. The file may be corrupt or in an unsupported format.",
      err,
    );
  }

  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (!metadata.width || !metadata.height) {
    throw new ImageProcessingError("Failed to read image dimensions from input.");
  }

  enforceDimensionLimits(sourceWidth, sourceHeight);

  const inputMime = metadata.format
    ? metadata.mediaType
      ? metadata.mediaType
      : formatToInputMime(metadata.format)
    : "unknown";

  // Flatten alpha when encoding to non-alpha formats.
  if (needsAlphaFlatten(format.mime) && metadata.hasAlpha) {
    pipeline = pipeline.flatten({ background: hexToSharpColor(opts.background) });
  }

  pipeline = applyResize(pipeline, opts.width, opts.height);

  pipeline = applyOutputFormat(pipeline, format.mime, opts);

  let buffer: Buffer;
  try {
    buffer = await pipeline.toBuffer();
  } catch (err) {
    throw new ImageProcessingError(`Failed to encode output as ${format.mime}.`, err);
  }

  // Determine output dimensions from the encoded buffer.
  const outMeta = await sharp(buffer).metadata();

  return {
    buffer,
    mime: format.mime,
    extension: format.extension,
    inputMime,
    sourceWidth,
    sourceHeight,
    outputWidth: outMeta.width ?? 0,
    outputHeight: outMeta.height ?? 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

interface NormalizedOptions {
  quality: number;
  deflateLevel: number;
  width?: number;
  height?: number;
  background: string;
}

function normalizeOptions(raw?: ConvertOptions): NormalizedOptions {
  const opts: NormalizedOptions = {
    quality: raw?.quality ?? DEFAULT_QUALITY,
    deflateLevel: raw?.deflateLevel ?? DEFAULT_DEFLATE_LEVEL,
    background: raw?.background ?? DEFAULT_JPEG_BACKGROUND,
    width: raw?.width,
    height: raw?.height,
  };

  if (opts.quality < 1 || opts.quality > 100 || !Number.isFinite(opts.quality)) {
    throw new InvalidOptionsError("quality must be an integer between 1 and 100");
  }
  if (opts.deflateLevel < 0 || opts.deflateLevel > 9 || !Number.isFinite(opts.deflateLevel)) {
    throw new InvalidOptionsError("deflateLevel must be an integer between 0 and 9");
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(opts.background)) {
    throw new InvalidOptionsError("background must be a 6-digit hex color like #ffffff");
  }
  if (opts.width !== undefined) {
    if (!Number.isInteger(opts.width) || opts.width <= 0 || opts.width > MAX_WIDTH) {
      throw new InvalidOptionsError(`width must be an integer between 1 and ${MAX_WIDTH}`);
    }
  }
  if (opts.height !== undefined) {
    if (!Number.isInteger(opts.height) || opts.height <= 0 || opts.height > MAX_HEIGHT) {
      throw new InvalidOptionsError(`height must be an integer between 1 and ${MAX_HEIGHT}`);
    }
  }
  return opts;
}

function enforceDimensionLimits(width: number, height: number): void {
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new ImageProcessingError(
      `Image dimensions ${width}x${height} exceed maximum allowed (${MAX_WIDTH}x${MAX_HEIGHT})`
    );
  }
}

/**
 * Formats that don't support alpha. For these we composite onto a solid
 * background before encoding.
 */
function needsAlphaFlatten(mime: string): boolean {
  return mime === "image/jpeg";
}

/**
 * Scan the RGBA bitmap for any non-opaque pixel. We bail out early on the
 * first hit — images with alpha typically have it everywhere.
 */
function formatToInputMime(format: string): string {
  const f = format.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    bmp: "image/bmp",
    tiff: "image/tiff",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
  };
  return map[f] ?? `image/${f}`;
}
