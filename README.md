# image-conv

Image format conversion API built on [Jimp](https://jimp-dev.github.io/jimp/), designed for integration with **n8n** workflow automation and any HTTP client.

## Features

- Convert images between **PNG, JPEG, BMP, TIFF, GIF, AVIF** in any direction
- Read **WebP** as input (decoded but not re-encoded — see Limitations)
- Optional **resize** during conversion (width / height / aspect ratio)
- Optional **quality** (JPEG/TIFF) and **deflateLevel** (PNG) tuning
- **JPEG alpha flattening** — transparent pixels are composited onto a configurable background color
- Two input modes: **multipart file upload** and **JSON base64** (for n8n)
- RFC 7807-style JSON error responses with appropriate HTTP status codes
- Health check and format discovery endpoints

## Quick start

```bash
npm install
npm run build
npm start          # listens on PORT (default 3028)
# or for development with auto-reload:
npm run dev
```

## API

### `GET /v1/formats`

Returns the supported input MIME types and output formats (with their available options). Useful for clients (like n8n) to discover what's available.

```bash
curl http://localhost:3028/v1/formats
```

### `GET /health`

Liveness probe.

```bash
curl http://localhost:3028/health
```

### `POST /v1/convert`

Convert an image. The request shape is selected automatically by the `Content-Type` header.

The target format can be provided in **any** of three ways (resolved in priority order):

1. `?format=jpeg` **query parameter** — cleanest for n8n URL-driven calls
2. `Accept: image/jpeg` **HTTP header** — native content negotiation
3. A `format` field in the **request body** (multipart or JSON)

The input format is **always auto-detected** from the file's magic bytes — no need to tell the API what the input is.

#### Multipart mode (typical for browser / n8n binary upload)

The file part can use **any** of these field names: `file` (default), `data` (n8n default), or `image`.

```bash
curl -X POST http://localhost:3028/v1/convert \
  -F "data=@input.png" \ 
  -F "format=jpeg" \
  -F "quality=85" \
  -F "width=800" \
  -F "background=#ffffff" \
  -o output.jpg
```

Or, URL-driven (all options as query params, only the binary in the body):

```bash
curl -X POST "http://localhost:3028/v1/convert?format=jpeg&quality=85&width=800&background=%23ffffff" \ 
  -F "data=@input.png" \
  -o output.jpg
```

Fields:

| Field          | Required | Description                                     |
|----------------|----------|-------------------------------------------------|
| `data`/`file`/`image` | yes | The image file (any of these field names)       |
| `format`       | yes¹     | Target format: `png`, `jpeg`, `bmp`, `tiff`, `gif`, `avif` |
| `quality`      | no       | JPEG/TIFF quality 1–100 (default 85)            |
| `deflateLevel` | no       | PNG compression 0–9 (default 6)                 |
| `width`        | no       | Resize to this width in pixels                  |
| `height`       | no       | Resize to this height in pixels                 |
| `background`   | no       | Hex color for JPEG alpha flattening (`#ffffff`) |

¹ Can also be supplied via `?format=` query param or `Accept: image/jpeg` header.

#### JSON mode (for n8n base64 workflows)

```bash
B64=$(base64 -i input.png)
curl -X POST http://localhost:7428/v1/convert \
  -H "Content-Type: application/json" \
  -d "{\"image\":\"data:image/png;base64,$B64\",\"format\":\"jpeg\",\"options\":{\"quality\":85,\"width\":800}}"
```

JSON body:

```json
{
  "image": "data:image/png;base64,iVBORw0KGgo...",
  "format": "jpeg",
  "options": {
    "quality": 85,
    "deflateLevel": 6,
    "width": 800,
    "height": null,
    "background": "#ffffff"
  }
}
```

The `image` field accepts either a raw base64 string or a `data:URL` with the media type prefix.

#### Response

By default the API returns the encoded image bytes with appropriate headers:

```
HTTP/1.1 200 OK
Content-Type: image/jpeg
Content-Disposition: attachment; filename="input.jpg"
X-Input-Mime: image/png
X-Input-Width: 1920
X-Input-Height: 1080
X-Output-Mime: image/jpeg
X-Output-Width: 800
X-Output-Height: 450

<binary image data>
```

The `X-Input-*` headers expose the **auto-detected** input format and dimensions, so callers know exactly what was processed without parsing the binary.

#### Base64 JSON response mode

For workflows that want the converted image wrapped in JSON (e.g. to pass through other JSON-only nodes), add `?response=base64`:

```bash
curl -X POST "http://localhost:3028/v1/convert?format=jpeg&response=base64&width=800" \ 
  -F "data=@input.png"
```

Returns:

```json
{
  "mime": "image/jpeg",
  "extension": "jpg",
  "data": "/9j/4AAQSkZJRgABAQAA...",
  "input":  { "mime": "image/png",  "width": 1920, "height": 1080 },
  "output": { "width": 800,  "height": 450 }
}
```

The same `X-Input-*` and `X-Output-*` headers are set on this response too.

#### Error responses

All errors use an RFC 7807-style JSON envelope:

```json
{
  "type": "https://api.example.com/errors/unsupported-format",
  "title": "Unsupported output format",
  "status": 415,
  "detail": "Unsupported output format 'webp'. Supported: png, jpeg, bmp, tiff, gif",
  "instance": "/v1/convert"
}
```

| Status | When                                                            |
|--------|-----------------------------------------------------------------|
| 400    | Missing or invalid fields (format, quality range, etc.)         |
| 413    | File exceeds `MAX_FILE_SIZE` (default 20 MB)                    |
| 415    | Unsupported output format or unsupported `Content-Type`         |
| 422    | Input image is corrupt or in an unrecognised format             |
| 500    | Unexpected server error                                         |

## Supported formats

| Direction  | PNG | JPEG | BMP | TIFF | GIF | AVIF |
|------------|-----|------|-----|------|-----|------|
| Read       | ✅  | ✅   | ✅  | ✅   | ✅  | ✅   |
| Write      | ✅  | ✅   | ✅  | ✅   | ✅  | ✅   |
| Read input | ✅  | ✅   | ✅  | ✅   | ✅  | ✅   |

WebP is **read** as input but **cannot be written** by Jimp. Requests for `format=webp` (or any unsupported format) return 415.

AVIF is supported via a custom WebAssembly plugin (see [src/services/avif-plugin.ts](src/services/avif-plugin.ts)) layered on top of the default Jimp formats. Encoding is slower than the bundled formats because it runs through WASM.

## Limitations

- **WebP encoding is not supported** — Jimp has no native WebP encoder. To add WebP output, swap to `sharp` or `@cwasm/webp`.
- **AVIF encoding is WASM-backed and slower** — each encode/decode initialises a WebAssembly module (cached after the first call), so throughput is lower than the bundled formats.
- **In-memory only** — Jimp holds the full image as an RGBA buffer, so very large images (>8000×8000) are rejected by default. Adjust `MAX_WIDTH` / `MAX_HEIGHT` in `src/config/formats.ts` if you need larger inputs.
- **GIF animation is flattened** — multi-frame GIFs are decoded as their first frame.

## Configuration

All settings are environment variables (loaded from `.env` via `dotenv`):

| Variable        | Default       | Description                          |
|-----------------|---------------|--------------------------------------|
| `PORT`          | `3028`        | HTTP port                            |
| `HOST`          | `0.0.0.0`     | Bind address                         |
| `MAX_FILE_SIZE` | `20971520`    | Max upload size in bytes (20 MB)     |
| `LOG_LEVEL`     | `info`        | Pino log level                       |

## Development

```bash
npm run dev         # tsx watch mode
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

## Project layout

```
src/
├── server.ts                  # Entry point
├── app.ts                     # buildApp() factory
├── config/formats.ts          # Supported formats and limits
├── routes/
│   ├── convert.ts             # POST /v1/convert
│   ├── formats.ts             # GET  /v1/formats
│   └── health.ts              # GET  /health
├── services/converter.ts      # Framework-agnostic conversion logic
├── plugins/error-handler.ts   # Centralised error → JSON mapping
└── types.ts                   # Shared TypeScript types
tests/
├── app.test.ts                # Integration tests (vitest + supertest)
└── setup.ts                   # Fixture generator
```
