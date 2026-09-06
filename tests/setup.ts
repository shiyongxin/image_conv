/**
 * Test fixture generator.
 *
 * Runs before the test suite to produce small PNG/JPEG/BMP/GIF/TIFF/AVIF
 * samples inside tests/fixtures/. We generate fixtures programmatically
 * with Jimp itself rather than committing binary blobs to the repo.
 *
 * IMPORTANT: the AVIF fixture requires the custom Jimp instance from
 * src/services/jimp.ts (the bundled `jimp` package does NOT include AVIF).
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Jimp as StockJimp } from "jimp";
import { Jimp } from "../src/services/jimp.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures");

type SupportedMime = "image/png" | "image/jpeg" | "image/bmp" | "image/gif" | "image/tiff" | "image/avif";

const FILES: Array<{ name: string; mime: SupportedMime; alpha?: boolean }> = [
  { name: "sample.png", mime: "image/png" },
  { name: "sample.jpg", mime: "image/jpeg" },
  { name: "sample.bmp", mime: "image/bmp" },
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
  // AVIF needs the custom Jimp (with the custom AVIF plugin); everything else
  // can use the stock bundle.
  const jimp = mime === "image/avif" ? Jimp : StockJimp;

  const image = new jimp({
    width: 16,
    height: 16,
    color: alpha ? 0x80808080 : 0xff3366cc, // ARGB int
  });
  // Paint some red dots in the corners so we have visible content.
  const red = 0xffff0000;
  image.setPixelColor(red, 0, 0);
  image.setPixelColor(red, 15, 0);
  image.setPixelColor(red, 0, 15);
  image.setPixelColor(red, 15, 15);

  if (alpha) {
    // Make a few pixels semi-transparent so JPEG conversion would lose data.
    const half = 0x80000000;
    image.setPixelColor(half, 4, 4);
    image.setPixelColor(half, 8, 8);
    image.setPixelColor(half, 12, 12);
  }

  await image.write(path as `${string}.${string}`);
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
  bmp: resolve(FIXTURES_DIR, "sample.bmp"),
  gif: resolve(FIXTURES_DIR, "sample.gif"),
  tiff: resolve(FIXTURES_DIR, "sample.tiff"),
  avif: resolve(FIXTURES_DIR, "sample.avif"),
  alphaPng: resolve(FIXTURES_DIR, "sample-alpha.png"),
};
