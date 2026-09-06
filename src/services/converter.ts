/**
 * Framework-agnostic image conversion service.
 *
 * Uses our custom Jimp instance (which adds AVIF support on top of the
 * default PNG/JPEG/BMP/TIFF/GIF/WebP formats) to read, transform, and
 * re-encode images. All operations happen in-memory; the caller is
 * responsible for stream/buffer lifecycle on the HTTP side.
 */

import {
  DEFAULT_DEFLATE_LEVEL,
  DEFAULT_JPEG_BACKGROUND,
  DEFAULT_QUALITY,
  MAX_HEIGHT,
  MAX_WIDTH,
  OutputFormatInfo,
  resolveOutputFormat,
} from "../config/formats.js";
import { Jimp } from "./jimp.js";

/**
 * Minimal structural type for the Jimp instance methods we use internally.
 * Jimp's published types split the constructor and the read/fromBuffer
 * return types into two structurally similar but nominally distinct shapes,
 * which makes them hard to unify. Using a structural alias here keeps the
 * helpers decoupled from those quirks while still type-checking.
 */
interface JimpLike {
  bitmap: { data: Buffer; width: number; height: number };
  getBuffer(mime: string, options?: Record<string, unknown>): Promise<Buffer>;
  composite(src: JimpLike, x: number, y: number): JimpLike;
  resize(opts: { w?: number; h?: number }): JimpLike;
  hasAlpha(): boolean;
}

/** Helper that turns any Jimp-compatible value into our internal shape. */
function asJimpLike(image: unknown): JimpLike {
  return image as JimpLike;
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
  /** Detected MIME type of the source image (auto-detected by Jimp from bytes). */
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

  let image: JimpLike;
  try {
    image = asJimpLike(await Jimp.read(input.buffer));
  } catch (err) {
    throw new ImageProcessingError(
      "Failed to decode input image. The file may be corrupt or in an unsupported format.",
      err
    );
  }

  enforceDimensionLimits(image.bitmap.width, image.bitmap.height);

  // Capture the input MIME that Jimp detected from the file's magic bytes.
  // We cast through unknown because the read/fromBuffer types in v1.x expose
  // `mime` as an optional property on the instance.
  const inputMime: string =
    (image as unknown as { mime?: string }).mime ?? "unknown";

  const sourceWidth = image.bitmap.width;
  const sourceHeight = image.bitmap.height;

  // 1. Flatten alpha channel if we're encoding to a format that doesn't
  //    support transparency (JPEG, BMP). We do this by compositing the
  //    image onto a solid-color canvas.
  if (needsAlphaFlatten(format.mime) && hasTransparency(image)) {
    image = flattenAlpha(image, opts.background);
  }

  // 2. Resize if requested.
  if (opts.width !== undefined || opts.height !== undefined) {
    image = applyResize(image, opts.width, opts.height);
  }

  const outputWidth = image.bitmap.width;
  const outputHeight = image.bitmap.height;

  // 3. Encode with format-specific tuning passed as options.
  //    Jimp v1.x dropped the chainable .quality() / .deflateLevel() helpers
  //    in favor of passing these options to getBuffer() directly.
  const encodeOptions = buildEncodeOptions(format.mime, opts);
  let buffer: Buffer;
  try {
    buffer = encodeOptions
      ? await image.getBuffer(format.mime, encodeOptions)
      : await image.getBuffer(format.mime);
  } catch (err) {
    throw new ImageProcessingError(
      `Failed to encode output as ${format.mime}.`,
      err
    );
  }

  return {
    buffer,
    mime: format.mime,
    extension: format.extension,
    inputMime,
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
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
  return mime === "image/jpeg" || mime === "image/bmp";
}

/**
 * Scan the RGBA bitmap for any non-opaque pixel. We bail out early on the
 * first hit — images with alpha typically have it everywhere.
 */
function hasTransparency(image: JimpLike): boolean {
  const data = image.bitmap.data;
  const len = data.length;
  // RGBA: stride of 4 bytes per pixel.
  for (let i = 3; i < len; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

/**
 * Composite the image onto a solid-color canvas of the same size. Returns
 * a new Jimp instance without alpha.
 */
function flattenAlpha(image: JimpLike, backgroundHex: string): JimpLike {
  const { width, height } = image.bitmap;
  // Create a canvas filled with the requested background color.
  // We cast through unknown because the Jimp constructor type and the
  // read/fromBuffer type are nominally distinct in v1.x despite sharing
  // most methods. Both produce instances with composite() / getBuffer().
  const canvas = asJimpLike(
    new Jimp({
      width,
      height,
      color: hexToRgba(backgroundHex),
    })
  );
  // Composite the original image on top — Jimp handles the alpha blending.
  canvas.composite(image, 0, 0);
  return canvas;
}

/**
 * Parse "#rrggbb" into a 32-bit RGBA integer suitable for Jimp v1.x color setters.
 * Returns ARGB packed into 0xAARRGGBB (where AA=0xFF for opaque).
 */
function hexToRgba(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return ((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

/**
 * Apply resize. In Jimp v1.x the resize method accepts either
 * `{ w, h? }` or `{ h, w? }` (one dimension required). If only one is given,
 * the plugin computes the other to preserve aspect ratio.
 */
function applyResize(image: JimpLike, width?: number, height?: number): JimpLike {
  if (width !== undefined && height !== undefined) {
    image.resize({ w: width, h: height });
  } else if (width !== undefined) {
    image.resize({ w: width });
  } else if (height !== undefined) {
    image.resize({ h: height });
  }
  return image;
}

/**
 * Build the per-format encode options passed to `getBuffer()`.
 * Jimp v1.x exposes quality / compression knobs via these options
 * rather than via chainable instance methods.
 */
function buildEncodeOptions(
  mime: string,
  opts: NormalizedOptions,
): Record<string, unknown> | undefined {
  switch (mime) {
    case "image/jpeg":
    case "image/tiff":
      return { quality: opts.quality };
    case "image/png":
      return { deflateLevel: opts.deflateLevel, deflateStrategy: 3 };
    case "image/avif":
      // AVIF uses `cqLevel` (libavif quantization) where LOWER = better
      // quality, opposite to JPEG's "higher = better". We invert our
      // user-facing 1–100 scale so the API stays consistent: passing
      // quality=100 → cqLevel=1 (visually lossless), quality=1 → cqLevel=63
      // (worst). The mapping is linear across the libavif range [1, 63].
      return { cqLevel: Math.round(63 - ((opts.quality - 1) * 62) / 99) };
    case "image/bmp":
    case "image/gif":
    default:
      return undefined;
  }
}
