/**
 * Single source of truth for supported image formats.
 *
 * sharp (libvips) natively supports read+write for: PNG, JPEG, TIFF, GIF,
 * AVIF, WebP. BMP is readable as input (libvips decodes), but sharp has no
 * BMP encoder, so it is not part of OUTPUT_FORMATS.
 *
 * This module exposes:
 *  - SUPPORTED_INPUT_MIMES: MIME types we can decode
 *  - OUTPUT_FORMATS: structured info about each writable format
 *  - lookup helpers for MIME ↔ extension conversion
 *  - default tuning parameters and limits
 */

export interface OutputFormatInfo {
  /** Canonical MIME type, e.g. "image/png" */
  mime: string;
  /** File extension WITHOUT the leading dot, e.g. "png" */
  extension: string;
  /** Names of options accepted by the /convert endpoint for this format */
  options: readonly string[];
}

export const SUPPORTED_INPUT_MIMES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/bmp",
  "image/tiff",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

/**
 * Output formats the API can produce, keyed by the user-facing identifier
 * they pass in the `format` field (case-insensitive on the wire, lowercase here).
 */
export const OUTPUT_FORMATS: Record<string, OutputFormatInfo> = {
  png: {
    mime: "image/png",
    extension: "png",
    options: ["deflateLevel"],
  },
  jpeg: {
    mime: "image/jpeg",
    extension: "jpg",
    options: ["quality"],
  },
  tiff: {
    mime: "image/tiff",
    extension: "tiff",
    options: ["quality"],
  },
  gif: {
    mime: "image/gif",
    extension: "gif",
    options: [],
  },
  avif: {
    mime: "image/avif",
    extension: "avif",
    options: ["quality"],
  },
  webp: {
    mime: "image/webp",
    extension: "webp",
    options: ["quality"],
  },
};

/** Aliases accepted on the wire (jpg → jpeg, etc.) */
const FORMAT_ALIASES: Record<string, string> = {
  jpg: "jpeg",
  jpe: "jpeg",
  tif: "tiff",
};

/**
 * Normalize a user-supplied format identifier and resolve to OutputFormatInfo.
 * Throws if the format is unsupported (including webp which has no encoder).
 */
export function resolveOutputFormat(input: string): OutputFormatInfo {
  const lower = input.trim().toLowerCase();
  const canonical = FORMAT_ALIASES[lower] ?? lower;
  const info = OUTPUT_FORMATS[canonical];
  if (!info) {
    throw new UnsupportedFormatError(
      `Unsupported output format '${input}'. Supported: ${Object.keys(OUTPUT_FORMATS).join(", ")}`
    );
  }
  return info;
}

/** Reverse lookup: MIME → user-facing format key */
const MIME_TO_FORMAT_KEY: Map<string, string> = new Map();
for (const [key, info] of Object.entries(OUTPUT_FORMATS)) {
  MIME_TO_FORMAT_KEY.set(info.mime, key);
}

export function mimeToFormatKey(mime: string): string | undefined {
  return MIME_TO_FORMAT_KEY.get(mime.toLowerCase());
}

// ────────────────────────────────────────────────────────────────────────────
// Defaults and limits
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_QUALITY = 85;
export const DEFAULT_DEFLATE_LEVEL = 6;
export const DEFAULT_JPEG_BACKGROUND = "#ffffff";

/** Default file size limit (20 MB). Override via MAX_FILE_SIZE env. */
export const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Hard ceilings on decoded image dimensions to prevent OOM. */
export const MAX_WIDTH = 8000;
export const MAX_HEIGHT = 8000;

// ────────────────────────────────────────────────────────────────────────────
// Error classes
// ────────────────────────────────────────────────────────────────────────────

/** Thrown when the requested output format is not in OUTPUT_FORMATS. */
export class UnsupportedFormatError extends Error {
  override readonly name = "UnsupportedFormatError";
}
