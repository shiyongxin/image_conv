/**
 * Single source of truth for supported image formats.
 *
 * Jimp v1.x natively supports read+write for: PNG, JPEG, BMP, TIFF, GIF.
 * WebP is read-only (no native encoder). AVIF is added via a custom plugin
 * (loaded in src/services/jimp.ts).
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
  "image/webp", // read-only on output side
  "image/avif", // via the custom plugin loaded in src/services/jimp.ts
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
  bmp: {
    mime: "image/bmp",
    extension: "bmp",
    options: [],
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
  // AVIF — provided by the custom plugin loaded in src/services/jimp.ts.
  // Encodes via WASM, so it's slower than the bundled formats. We expose a
  // `quality` knob that maps to the libavif `cqLevel` quantization parameter
  // (lower = better, inverted from JPEG's scale).
  avif: {
    mime: "image/avif",
    extension: "avif",
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
