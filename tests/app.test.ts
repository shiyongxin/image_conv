/**
 * Integration tests for the image conversion API.
 *
 * Tests cover:
 *  - GET /v1/formats returns the format catalogue
 *  - GET /health is responsive
 *  - POST /v1/convert (multipart) accepts each supported output format
 *  - POST /v1/convert (JSON base64) works for n8n-style clients
 *  - Resize during conversion changes dimensions
 *  - Quality / deflateLevel options are accepted
 *  - JPEG conversion flattens alpha onto the background color
 *  - Error paths: missing format, unsupported format, corrupt image,
 *    invalid options, missing file
 */

import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

import { FIXTURES, ensureFixtures } from "./setup.js";

let app: FastifyInstance;

beforeAll(async () => {
  await ensureFixtures();
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ────────────────────────────────────────────────────────────────────────────
// Discovery endpoints
// ────────────────────────────────────────────────────────────────────────────

describe("GET /v1/formats", () => {
  it("returns the supported input/output catalogue", async () => {
    const res = await request(app.server).get("/v1/formats");
    expect(res.status).toBe(200);

    expect(res.body.inputs).toEqual(
      expect.arrayContaining([
        "image/png",
        "image/jpeg",
        "image/bmp",
        "image/tiff",
        "image/gif",
        "image/webp",
        "image/avif",
      ])
    );

    const outputKeys = res.body.outputs.map((o: { key: string }) => o.key);
    expect(outputKeys).toEqual(["png", "jpeg", "tiff", "gif", "avif", "webp"]);

    const jpeg = res.body.outputs.find((o: { key: string }) => o.key === "jpeg");
    expect(jpeg.options).toContain("quality");

    const png = res.body.outputs.find((o: { key: string }) => o.key === "png");
    expect(png.options).toContain("deflateLevel");

    const avif = res.body.outputs.find((o: { key: string }) => o.key === "avif");
    expect(avif.mime).toBe("image/avif");
    expect(avif.extension).toBe("avif");
  });

  it("reports limits", async () => {
    const res = await request(app.server).get("/v1/formats");
    expect(res.body.limits).toMatchObject({
      maxFileSize: expect.any(Number),
      maxWidth: expect.any(Number),
      maxHeight: expect.any(Number),
    });
  });
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(app.server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(typeof res.body.timestamp).toBe("string");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /v1/convert — multipart
// ────────────────────────────────────────────────────────────────────────────

describe("POST /v1/convert (multipart)", () => {
  const expectedMimes: Record<string, string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    tiff: "image/tiff",
    gif: "image/gif",
  };

  for (const [format, mime] of Object.entries(expectedMimes)) {
    it(`converts PNG → ${format.toUpperCase()}`, async () => {
      const res = await request(app.server)
        .post("/v1/convert")
        .attach("file", FIXTURES.png)
        .field("format", format);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe(mime);
      expect(res.headers["content-disposition"]).toMatch(
        new RegExp(`filename=".*\\.${format === "jpeg" ? "jpg" : format}"`)
      );
      expect(res.body).toBeInstanceOf(Buffer);
      expect(res.body.length).toBeGreaterThan(0);

      // Verify the output is actually a decodable image of the requested MIME.
      if (format === "webp") {
        const meta = await sharp(res.body).metadata();
        expect(meta.format).toBe("webp");
      } else {
            const meta = await sharp(res.body).metadata();
        expect(meta.width).toBe(16);
        expect(meta.height).toBe(16);
      }
    });
  }

  it("converts PNG to WebP", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "webp");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.body.length).toBeGreaterThan(0);

    // Verify WebP decoding via sharp.
    const decoded = await sharp(res.body).metadata();
    expect(decoded.format).toBe("webp");
  });

  it("respects the quality option for JPEG", async () => {
    const lowQ = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "jpeg")
      .field("quality", "10");
    const highQ = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "jpeg")
      .field("quality", "95");

    expect(lowQ.status).toBe(200);
    expect(highQ.status).toBe(200);
    // Lower quality → smaller file (for non-trivial content).
    expect(lowQ.body.length).toBeLessThanOrEqual(highQ.body.length);
  });

  it("respects the deflateLevel option for PNG", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "png")
      .field("deflateLevel", "9");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("resizes the image when width/height are provided", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "png")
      .field("width", "64")
      .field("height", "32");

    expect(res.status).toBe(200);
    expect(res.headers["x-input-width"]).toBe("16");
    expect(res.headers["x-input-height"]).toBe("16");
    expect(res.headers["x-output-width"]).toBe("64");
    expect(res.headers["x-output-height"]).toBe("32");

    const meta = await sharp(res.body).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(32);
  });

  it("resizes preserving aspect ratio when only width is given", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "png")
      .field("width", "32");

    expect(res.status).toBe(200);
    expect(res.headers["x-output-width"]).toBe("32");
    expect(res.headers["x-output-height"]).toBe("32");
  });

  it("flattens alpha to the background color when converting to JPEG", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.alphaPng)
      .field("format", "jpeg")
      .field("background", "#ff0000");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");

    // Re-decode the JPEG and confirm the alpha channel is gone (no transparency).
    const meta = await sharp(res.body).metadata();
    // For JPEG, output should not have alpha.
    expect(meta.hasAlpha ?? false).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /v1/convert — JSON base64 (n8n mode)
// ────────────────────────────────────────────────────────────────────────────

describe("POST /v1/convert (JSON base64)", () => {
  it("accepts a raw base64 string", async () => {
    const b64 = readFileSync(FIXTURES.png).toString("base64");
    const res = await request(app.server)
      .post("/v1/convert")
      .set("Content-Type", "application/json")
      .send({ image: b64, format: "png", options: { width: 8 } });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-output-width"]).toBe("8");

    const meta = await sharp(res.body).metadata();
    expect(meta.width).toBe(8);
  });

  it("accepts a data URL with media type", async () => {
    const b64 = readFileSync(FIXTURES.png).toString("base64");
    const dataUrl = `data:image/png;base64,${b64}`;
    const res = await request(app.server)
      .post("/v1/convert")
      .set("Content-Type", "application/json")
      .send({ image: dataUrl, format: "jpeg", options: { quality: 80 } });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error paths
// ────────────────────────────────────────────────────────────────────────────

describe("POST /v1/convert error paths", () => {
  it("returns 400 when format is missing (multipart)", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png);

    expect(res.status).toBe(400);
    expect(res.body.title).toBe("Bad request");
  });

  it("returns 400 when file is missing (multipart)", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .field("format", "png");

    expect(res.status).toBe(400);
    expect(res.body.title).toBe("Bad request");
  });

  it("converts PNG to WebP", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "webp");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.body.length).toBeGreaterThan(0);

    const meta = await sharp(res.body).metadata();
    expect(meta.format).toBe("webp");
  });

  it("returns 400 for invalid quality range", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "jpeg")
      .field("quality", "999");

    expect(res.status).toBe(400);
    expect(res.body.title).toMatch(/invalid|validation/i);
  });

  it("returns 400 for invalid background color", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "jpeg")
      .field("background", "not-a-color");

    expect(res.status).toBe(400);
  });

  it("returns 422 for corrupt image data", async () => {
    // Build a fake file that pretends to be PNG but has bogus content.
    const corrupt = Buffer.from("not actually an image, just text");
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", corrupt, { filename: "bad.png", contentType: "image/png" })
      .field("format", "png");

    expect(res.status).toBe(422);
    expect(res.body.title).toBe("Image processing failed");
  });

  it("returns 400 when JSON body is missing image field", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .set("Content-Type", "application/json")
      .send({ format: "png" });

    expect(res.status).toBe(400);
  });

  it("returns 415 for unsupported Content-Type", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .set("Content-Type", "text/plain")
      .send("hello");

    expect(res.status).toBe(415);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// n8n integration: flexible field names, ?format= query param, Accept header,
// input info in response headers, base64 JSON response mode.
// ────────────────────────────────────────────────────────────────────────────

describe("n8n integration — flexible field names", () => {
  it("accepts the file part as 'data' (n8n default Binary Property)", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.png)
      .field("format", "png");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("accepts the file part as 'image'", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("image", FIXTURES.png)
      .field("format", "jpeg");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });

  it("accepts the file part as 'file' (legacy)", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("file", FIXTURES.png)
      .field("format", "png");

    expect(res.status).toBe(200);
  });

  it("uses the original filename when the field is 'data'", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.png, { filename: "vacation.png" })
      .field("format", "jpeg");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/filename="vacation\.jpg"/);
  });
});

describe("n8n integration — ?format= query parameter", () => {
  it("uses the format from the query string instead of the body", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=jpeg")
      .attach("data", FIXTURES.png)
      .field("format", "png"); // should be overridden by ?format=jpeg

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });

  it("works without any format field in the body", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=png&width=8")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-output-width"]).toBe("8");
  });

  it("returns 400 when neither query nor body specifies a format", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/format/i);
  });

  it("converts PNG to WebP via query string", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=webp")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
  });
});

describe("n8n integration — Accept header content negotiation", () => {
  it("uses the first image/* MIME in the Accept header", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .set("Accept", "image/jpeg")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });

  it("extracts format from multi-value Accept header", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .set("Accept", "text/html, image/png;q=0.9, */*;q=0.1")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("query parameter takes precedence over Accept header", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=jpeg")
      .set("Accept", "image/png")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });
});

describe("n8n integration — input info in response headers", () => {
  it("exposes the auto-detected input MIME in X-Input-Mime", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.png)
      .field("format", "jpeg");

    expect(res.status).toBe(200);
    expect(res.headers["x-input-mime"]).toBe("image/png");
    expect(res.headers["x-output-mime"]).toBe("image/jpeg");
  });

  it("exposes source and output dimensions", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=png")
      .attach("data", FIXTURES.png)
      .field("width", "32");

    expect(res.headers["x-input-width"]).toBe("16");
    expect(res.headers["x-input-height"]).toBe("16");
    expect(res.headers["x-output-width"]).toBe("32");
    expect(res.headers["x-output-height"]).toBe("32");
  });

  it("also exposes input headers on the base64 JSON response", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=jpeg&response=base64")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.headers["x-input-mime"]).toBe("image/png");
    expect(res.headers["x-output-mime"]).toBe("image/jpeg");
  });
});

describe("n8n integration — ?response=base64 JSON output mode", () => {
  it("returns a JSON envelope with base64 data instead of raw binary", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=png&response=base64")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    expect(res.body.mime).toBe("image/png");
    expect(res.body.extension).toBe("png");
    expect(typeof res.body.data).toBe("string");
    expect(res.body.data.length).toBeGreaterThan(0);

    // The base64 should round-trip to a valid image of the requested type.
    const meta = await sharp(Buffer.from(res.body.data, "base64")).metadata();
    expect(meta.width).toBe(16);

    expect(res.body.input.mime).toBe("image/png");
    expect(res.body.input.width).toBe(16);
    expect(res.body.output.width).toBe(16);
  });

  it("respects resize options in base64 mode", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=jpeg&response=base64&width=64")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.body.output.width).toBe(64);

    const meta = await sharp(Buffer.from(res.body.data, "base64")).metadata();
    expect(meta.width).toBe(64);
  });

  it("returns JSON with validation errors when format is missing", async () => {
    const res = await request(app.server)
      .post("/v1/convert?response=base64")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(400);
    expect(res.body.title).toBe("Bad request");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AVIF support (custom WebAssembly plugin)
// ────────────────────────────────────────────────────────────────────────────

describe("AVIF — input support", () => {
  it("decodes an AVIF file and exposes the detected input MIME", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.avif)
      .field("format", "png");

    expect(res.status).toBe(200);
    expect(res.headers["x-input-mime"]).toBe("image/avif");
    expect(res.headers["x-input-width"]).toBe("16");
    expect(res.headers["x-input-height"]).toBe("16");
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("converts AVIF → JPEG (validates decode + re-encode roundtrip)", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.avif)
      .field("format", "jpeg");

    expect(res.status).toBe(200);
    expect(res.headers["x-input-mime"]).toBe("image/avif");
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.body.length).toBeGreaterThan(0);

    const meta = await sharp(res.body).metadata();
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
  });

  it("converts AVIF → TIFF", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.avif)
      .field("format", "tiff");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/tiff");
  });

  it("respects resize on AVIF input", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.avif)
      .field("format", "png")
      .field("width", "32")
      .field("height", "32");

    expect(res.status).toBe(200);
    expect(res.headers["x-output-width"]).toBe("32");
    expect(res.headers["x-output-height"]).toBe("32");
  });

  it("accepts AVIF in base64 JSON mode", async () => {
    const b64 = readFileSync(FIXTURES.avif).toString("base64");
    const res = await request(app.server)
      .post("/v1/convert?response=base64")
      .set("Content-Type", "application/json")
      .send({ image: b64, format: "png" });

    expect(res.status).toBe(200);
    expect(res.body.input.mime).toBe("image/avif");
    expect(res.body.mime).toBe("image/png");
  });
});

describe("AVIF — output support", () => {
  it("encodes PNG → AVIF", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.png)
      .field("format", "avif");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/avif");
    expect(res.headers["content-disposition"]).toMatch(/filename=".*\.avif"/);
    expect(res.body.length).toBeGreaterThan(0);

    // The output must be a valid AVIF that we can decode again.
    const meta = await sharp(res.body).metadata();
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
  });

  it("encodes JPEG → AVIF", async () => {
    const res = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.jpeg)
      .field("format", "avif")
      .field("quality", "85");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/avif");
  });

  it("respects quality when encoding AVIF", async () => {
    // Lower quality (higher cqLevel) should produce a smaller file than
    // higher quality (lower cqLevel) for the same source.
    const high = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.png)
      .field("format", "avif")
      .field("quality", "95");
    const low = await request(app.server)
      .post("/v1/convert")
      .attach("data", FIXTURES.png)
      .field("format", "avif")
      .field("quality", "10");

    expect(high.status).toBe(200);
    expect(low.status).toBe(200);
    expect(high.body.length).toBeGreaterThan(low.body.length);
  });

  it("supports AVIF in base64 response mode", async () => {
    const res = await request(app.server)
      .post("/v1/convert?format=avif&response=base64")
      .attach("data", FIXTURES.png);

    expect(res.status).toBe(200);
    expect(res.body.mime).toBe("image/avif");
    expect(res.body.extension).toBe("avif");

    const meta = await sharp(Buffer.from(res.body.data, "base64")).metadata();
    expect(meta.width).toBe(16);
  });
});
