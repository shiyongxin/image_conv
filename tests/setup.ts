/**
 * Test fixture generator.
 *
 * Runs before the test suite to produce small PNG/JPEG/GIF/TIFF/AVIF
 * samples inside tests/fixtures/. We generate fixtures programmatically
 * with sharp rather than committing binary blobs to the repo.
 *
 * IMPORTANT: fixtures are generated using sharp (native libvips) so AVIF/WebP
 * tests use the same engine stack as the API.
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Metadata } from "sharp";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures");

type SupportedMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/tiff"
  | "image/avif";

const FILES: Array<{ name: string; mime: SupportedMime; alpha?: boolean }> = [
  { name: "sample.png", mime: "image/png" },
  { name: "sample.jpg", mime: "image/jpeg" },
  { name: "sample.gif", mime: "image/gif" },
  { name: "sample.tiff", mime: "image/tiff" },
  { name: "sample.avif", mime: "image/avif" },
  // PNG with alpha — used to test the JPEG flatten behavior.
  { name: "sample-alpha.png", mime: "image/png", alpha: true },
];

/**
 * Create a 16x16 image with a colored background and (optionally) alpha.
 * @param alpha when true, the image is RGBA with some pixels at 50% opacity
 */
async function makeImage(
  path: string,
  mime: SupportedMime,
  alpha: boolean,
): Promise<void> {
  // Create a 16x16 raw RGBA buffer (BGRA is not used; sharp expects RGBA here).
  const width = 16;
  const height = 16;
  const rgba = Buffer.alloc(width * height * 4);

  // Base color: #33 66 cc (RGB) with optional alpha.
  const baseR = 0x33;
  const baseG = 0x66;
  const baseB = 0xcc;
  const baseA = alpha ? 0x80 : 0xff;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = baseR;
      rgba[i + 1] = baseG;
      rgba[i + 2] = baseB;
      rgba[i + 3] = baseA;
    }
  }

  // Red corners.
  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const i = (y * width + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  };

  const red = { r: 0xff, g: 0x00, b: 0x00 };
  setPixel(0, 0, red.r, red.g, red.b, 0xff);
  setPixel(15, 0, red.r, red.g, red.b, 0xff);
  setPixel(0, 15, red.r, red.g, red.b, 0xff);
  setPixel(15, 15, red.r, red.g, red.b, 0xff);

  if (alpha) {
    // Semi-transparent diagonal pixels.
    const halfA = 0x80;
    setPixel(4, 4, baseR, baseG, baseB, halfA);
    setPixel(8, 8, baseR, baseG, baseB, halfA);
    setPixel(12, 12, baseR, baseG, baseB, halfA);
  }

  const img = sharp(rgba, { raw: { width, height, channels: 4 } });

  if (mime === "image/png") await img.png().toFile(path);
  else if (mime === "image/jpeg") await img.jpeg().toFile(path);

  else if (mime === "image/gif") await img.gif().toFile(path);
  else if (mime === "image/tiff") await img.tiff().toFile(path);
  else if (mime === "image/avif") await img.avif().toFile(path);
  else throw new Error(`Unsupported fixture mime: ${mime}`);
}

export async function ensureFixtures(): Promise<void> {
  if (!existsSync(FIXTURES_DIR)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  for (const f of FILES) {
    const path = resolve(FIXTURES_DIR, f.name);
    if (existsSync(path)) continue;
    await makeImage(path, f.mime, f.alpha === true);
  }
}

export const FIXTURES = {
  png: resolve(FIXTURES_DIR, "sample.png"),
  jpeg: resolve(FIXTURES_DIR, "sample.jpg"),
  gif: resolve(FIXTURES_DIR, "sample.gif"),
  tiff: resolve(FIXTURES_DIR, "sample.tiff"),
  avif: resolve(FIXTURES_DIR, "sample.avif"),
  alphaPng: resolve(FIXTURES_DIR, "sample-alpha.png"),
};
