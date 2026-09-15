# image_conv Migration: Jimp+WASM to sharp

> Version 1.0 | Date 2026-09-15 | Repo shiyongxin/image_conv

## 1. Background

image_conv is a TypeScript image format conversion REST API built on Jimp + @jsquash/avif (WASM), designed for n8n workflow integration.

Current problems:
- AVIF encode/decode uses WASM (cold start 2-5s)
- WebP cannot be encoded (415 error)
- Large images rejected (>8000x8000)
- Pure JS performance 4-25x slower than native

sharp (v0.35.4) uses native libvips C bindings, supports AVIF+WebP read/write natively, requires Node >=20.9.0.

## 2. Goals

- Eliminate WASM cold start
- Add WebP encoding support
- 4-25x performance improvement
- Reduce dependencies from 3 to 1
- Remove 8000x8000 image limit

## 3. Current Architecture

See https://github.com/shiyongxin/image_conv for full source.

Key files:
- src/services/converter.ts - core conversion logic (Jimp)
- src/services/jimp.ts - custom Jimp instance with AVIF plugin
- src/services/avif-plugin.ts - AVIF WASM plugin
- src/config/formats.ts - format definitions
- src/routes/convert.ts - POST /v1/convert route
- src/routes/formats.ts - GET /v1/formats route

## 4. Execution Plan (11 Steps)

### Step 1: Update package.json
Remove jimp, @jimp/core, @jsquash/avif. Add sharp. Update engines to >=20.9.0.

### Step 2: Delete WASM files
Delete src/services/avif-plugin.ts and src/services/jimp.ts.

### Step 3: Rewrite converter.ts
Replace Jimp API with sharp API. Keep ConvertInput/ConvertResult/ConvertOptions interfaces unchanged.

### Step 4: Update formats.ts
Add webp to OUTPUT_FORMATS.

### Step 5: Update formats route
Remove WASM-related notes.

### Step 6: Update tests
Replace Jimp with sharp for verification. Add WebP tests.

### Step 7: Add WebP fixture
Generate WebP test fixture if missing.

### Step 8: Update README
Document sharp migration and WebP support.

### Step 9: Type check
Run npm run typecheck.

### Step 10: Run tests
Run npm test.

### Step 11: E2E verification
Test PNG->JPEG, PNG->AVIF, PNG->WebP, AVIF->JPEG.


---

## 5. API Mapping Reference

### 5.1 Core Operations

| Operation | Jimp (current) | sharp (target) |
|-----------|----------------|----------------|
| Decode | `Jimp.read(buffer)` | `sharp(buffer)` |
| Width | `image.bitmap.width` | `metadata.width` |
| Height | `image.bitmap.height` | `metadata.height` |
| Input format | `image.mime` | `metadata.format` -> MIME map |
| Has alpha | `hasTransparency()` pixel scan | `metadata.hasAlpha` |
| Flatten alpha | `flattenAlpha()` canvas+composite | `image.flatten({background:{r,g,b}})` |
| Resize both | `image.resize({w,h})` | `image.resize({width,height,fit:'fill'})` |
| Resize width only | `image.resize({w})` | `image.resize({width,fit:'inside'})` |
| Resize height only | `image.resize({h})` | `image.resize({height,fit:'inside'})` |

### 5.2 Encode Format Mapping

| Format | Jimp getBuffer | sharp chain |
|--------|---------------|-------------|
| PNG | `getBuffer("image/png",{deflateLevel})` | `.png({compressionLevel}).toBuffer()` |
| JPEG | `getBuffer("image/jpeg",{quality})` | `.jpeg({quality}).toBuffer()` |
| BMP | `getBuffer("image/bmp")` | `.bmp().toBuffer()` |
| TIFF | `getBuffer("image/tiff",{quality})` | `.tiff({quality}).toBuffer()` |
| GIF | `getBuffer("image/gif")` | `.gif().toBuffer()` |
| AVIF | `getBuffer("image/avif",{cqLevel})` | `.avif({quality}).toBuffer()` |
| WebP | NOT SUPPORTED | `.webp({quality}).toBuffer()` |

### 5.3 AVIF Quality Mapping

Current: `cqLevel = round(63 - ((quality-1)*62)/99)` (lower=better)
Target: pass `quality` directly to sharp (higher=better, sharp handles mapping)

### 5.4 metadata.format to MIME

```typescript
const FORMAT_TO_MIME: Record<string, string> = {
  png: "image/png", jpeg: "image/jpeg", bmp: "image/bmp",
  tiff: "image/tiff", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml",
};
```

### 5.5 Hex Color Conversion

```typescript
// Jimp: hex -> 32-bit ARGB integer
function hexToRgba(hex: string): number {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return ((0xff<<24)|(r<<16)|(g<<8)|b)>>>0;
}

// sharp: hex -> {r,g,b} object
function hexToSharpColor(hex: string): {r:number;g:number;b:number} {
  return {
    r: parseInt(hex.slice(1,3),16),
    g: parseInt(hex.slice(3,5),16),
    b: parseInt(hex.slice(5,7),16),
  };
}
```

---

## 6. Detailed Step-by-Step

### Step 1: Update Dependencies

**File**: `package.json` | **Priority**: HIGH | **Effort**: 5 min

```diff
  "dependencies": {
    "@fastify/multipart": "^9.0.3",
-   "@jimp/core": "^1.6.1",
-   "@jsquash/avif": "^1.3.0",
    "dotenv": "^16.4.7",
    "fastify": "^5.2.1",
-   "jimp": "^1.6.0",
+   "sharp": "^0.35.4"
  },
  "engines": {
-   "node": ">=20"
+   "node": ">=20.9.0"
  }
```

Verify:
```bash
rm -rf node_modules package-lock.json
npm install
node -e "console.log(require('sharp').versions)"
```

### Step 2: Delete WASM Files

**Priority**: HIGH | **Effort**: 1 min

| File | Reason |
|------|--------|
| `src/services/avif-plugin.ts` | WASM AVIF plugin, replaced by sharp native |
| `src/services/jimp.ts` | Custom Jimp instance, no longer needed |

### Step 3: Rewrite converter.ts

**File**: `src/services/converter.ts` | **Priority**: HIGH | **Effort**: 30 min

#### Preserved exports (NO CHANGE)

```typescript
export interface ConvertOptions {
  quality?: number;
  deflateLevel?: number;
  width?: number;
  height?: number;
  background?: string;
}

export interface ConvertInput {
  buffer: Buffer;
  outputFormat: string;
  options?: ConvertOptions;
}

export interface ConvertResult {
  buffer: Buffer;
  mime: string;
  extension: string;
  inputMime: string;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

export class ImageProcessingError extends Error { ... }
export class InvalidOptionsError extends Error { ... }
export class ImageTooLargeError extends Error { ... }
export async function convertImage(input: ConvertInput): Promise<ConvertResult>;
```

#### Removed internal helpers

| Function | Replaced by |
|----------|-------------|
| `asJimpLike()` | not needed |
| `hasTransparency()` | `metadata.hasAlpha` |
| `flattenAlpha()` | `sharp.flatten()` |
| `hexToRgba()` | `hexToSharpColor()` |
| `applyResize()` | `sharp.resize()` |
| `buildEncodeOptions()` | sharp chain API |
| `JimpLike` interface | not needed |

#### New convertImage implementation (pseudocode)

```typescript
import sharp from "sharp";

export async function convertImage(input: ConvertInput): Promise<ConvertResult> {
  const format = resolveOutputFormat(input.outputFormat);
  const opts = normalizeOptions(input.options);

  // 1. Decode + get metadata
  let pipeline = sharp(input.buffer);
  let metadata: sharp.Metadata;
  try {
    metadata = await pipeline.metadata();
  } catch (err) {
    throw new ImageProcessingError("Failed to decode...", err);
  }

  // 2. Enforce dimension limits
  enforceDimensionLimits(metadata.width!, metadata.height!);

  // 3. Capture input info
  const inputMime = formatToMime(metadata.format);
  const sourceWidth = metadata.width!;
  const sourceHeight = metadata.height!;

  // 4. Flatten alpha for JPEG/BMP
  if (needsAlphaFlatten(format.mime) && metadata.hasAlpha) {
    pipeline = pipeline.flatten({
      background: hexToSharpColor(opts.background),
    });
  }

  // 5. Resize
  if (opts.width !== undefined || opts.height !== undefined) {
    pipeline = applyResize(pipeline, opts.width, opts.height);
  }

  // 6. Encode
  pipeline = applyOutputFormat(pipeline, format.mime, opts);

  let buffer: Buffer;
  try {
    buffer = await pipeline.toBuffer();
  } catch (err) {
    throw new ImageProcessingError(`Failed to encode...`, err);
  }

  // 7. Get output dimensions
  const outputMeta = await sharp(buffer).metadata();

  return {
    buffer, mime: format.mime, extension: format.extension,
    inputMime, sourceWidth, sourceHeight,
    outputWidth: outputMeta.width!, outputHeight: outputMeta.height!,
  };
}
```

#### New helper: applyOutputFormat

```typescript
function applyOutputFormat(
  pipeline: sharp.Sharp,
  mime: string,
  opts: NormalizedOptions,
): sharp.Sharp {
  switch (mime) {
    case "image/jpeg":
      return pipeline.jpeg({ quality: opts.quality });
    case "image/png":
      return pipeline.png({ compressionLevel: opts.deflateLevel });
    case "image/webp":
      return pipeline.webp({ quality: opts.quality });
    case "image/avif":
      return pipeline.avif({ quality: opts.quality });
    case "image/tiff":
      return pipeline.tiff({ quality: opts.quality });
    case "image/bmp":
      return pipeline.bmp();
    case "image/gif":
      return pipeline.gif();
    default:
      return pipeline;
  }
}
```

#### New helper: applyResize (sharp version)

```typescript
function applyResize(
  pipeline: sharp.Sharp,
  width?: number,
  height?: number,
): sharp.Sharp {
  if (width !== undefined && height !== undefined) {
    return pipeline.resize({ width, height, fit: "fill" });
  } else if (width !== undefined) {
    return pipeline.resize({ width, fit: "inside" });
  } else {
    return pipeline.resize({ height, fit: "inside" });
  }
}
```


### Step 4: Update formats.ts

**File**: `src/config/formats.ts` | **Priority**: HIGH | **Effort**: 5 min

#### Add WebP to OUTPUT_FORMATS

```diff
 export const OUTPUT_FORMATS: Record<string, OutputFormatInfo> = {
   png: { mime: "image/png", extension: "png", options: ["deflateLevel"] },
   jpeg: { mime: "image/jpeg", extension: "jpg", options: ["quality"] },
   bmp: { mime: "image/bmp", extension: "bmp", options: [] },
   tiff: { mime: "image/tiff", extension: "tiff", options: ["quality"] },
   gif: { mime: "image/gif", extension: "gif", options: [] },
   avif: { mime: "image/avif", extension: "avif", options: ["quality"] },
+  webp: { mime: "image/webp", extension: "webp", options: ["quality"] },
 };
```

#### Update comments

```diff
- * Jimp v1.x natively supports read+write for: PNG, JPEG, BMP, TIFF, GIF.
- * WebP is read-only (no native encoder). AVIF is added via a custom plugin.
+ * sharp (libvips) natively supports read+write for: PNG, JPEG, BMP, TIFF,
+ * GIF, AVIF, WebP. All formats are handled by native C bindings.
```

### Step 5: Update formats route

**File**: `src/routes/formats.ts` | **Priority**: MEDIUM | **Effort**: 3 min

```diff
       notes: [
-        "WebP is supported as INPUT only — Jimp has no WebP encoder.",
-        "AVIF is supported via a custom WebAssembly plugin (slower than the bundled formats).",
+        "All formats (including WebP and AVIF) are supported for both input and output via sharp (native libvips).",
         "When converting to JPEG, any alpha channel is flattened onto the background color (default #ffffff).",
       ],
```

### Step 6: Update tests

**File**: `tests/app.test.ts` | **Priority**: HIGH | **Effort**: 20 min

#### 6.1 Replace imports

```diff
- import { Jimp } from "jimp";
- import { Jimp as AvifJimp } from "../src/services/jimp.js";
+ import sharp from "sharp";
```

#### 6.2 Replace image verification

All occurrences of:
```typescript
const decoded = await Jimp.read(res.body);
expect(decoded.bitmap.width).toBe(16);
```

Replace with:
```typescript
const meta = await sharp(res.body).metadata();
expect(meta.width).toBe(16);
```

#### 6.3 Replace alpha verification

```diff
- const decoded = await Jimp.read(res.body);
- expect(decoded.hasAlpha()).toBe(false);
+ const meta = await sharp(res.body).metadata();
+ expect(meta.hasAlpha).toBe(false);
```

#### 6.4 Change WebP 415 test to 200

```diff
- it("returns 415 for unsupported output format", async () => {
-   const res = await request(app.server)
-     .post("/v1/convert")
-     .attach("file", FIXTURES.png)
-     .field("format", "webp");
-   expect(res.status).toBe(415);
-   expect(res.body.title).toBe("Unsupported output format");
- });
+ it("converts PNG to WebP", async () => {
+   const res = await request(app.server)
+     .post("/v1/convert")
+     .attach("file", FIXTURES.png)
+     .field("format", "webp");
+   expect(res.status).toBe(200);
+   expect(res.headers["content-type"]).toBe("image/webp");
+   expect(res.body).toBeInstanceOf(Buffer);
+   expect(res.body.length).toBeGreaterThan(0);
+ });
```

#### 6.5 Change query param WebP test

```diff
- it("returns 415 for unsupported format in query string", async () => {
-   const res = await request(app.server)
-     .post("/v1/convert?format=webp")
-     .attach("data", FIXTURES.png);
-   expect(res.status).toBe(415);
- });
+ it("accepts webp format in query string", async () => {
+   const res = await request(app.server)
+     .post("/v1/convert?format=webp")
+     .attach("data", FIXTURES.png);
+   expect(res.status).toBe(200);
+   expect(res.headers["content-type"]).toBe("image/webp");
+ });
```

#### 6.6 Add WebP to format catalogue test

```diff
- const outputKeys = res.body.outputs.map((o) => o.key);
- expect(outputKeys).toEqual(["png", "jpeg", "bmp", "tiff", "gif", "avif"]);
+ const outputKeys = res.body.outputs.map((o) => o.key);
+ expect(outputKeys).toEqual(["png", "jpeg", "bmp", "tiff", "gif", "avif", "webp"]);
```

#### 6.7 Add WebP to multipart format loop

```diff
  const expectedMimes: Record<string, string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    bmp: "image/bmp",
    tiff: "image/tiff",
    gif: "image/gif",
+   webp: "image/webp",
  };
```

### Step 7: Add WebP fixture

**File**: `tests/setup.ts` | **Priority**: MEDIUM | **Effort**: 5 min

Add WebP fixture generation using sharp:

```typescript
// In ensureFixtures():
if (!existsSync(FIXTURES.webp)) {
  await sharp(FIXTURES.png).webp().toFile(FIXTURES.webp);
}
```

Add to FIXTURES object:
```typescript
webp: path.join(FIXTURES_DIR, "sample.webp"),
```

### Step 8: Update README

**File**: `README.md` | **Priority**: MEDIUM | **Effort**: 10 min

| Section | Change |
|---------|--------|
| Title | "built on Jimp" -> "built on sharp" |
| Features | Add WebP to writable formats |
| Format matrix | WebP: read+write, AVIF: native (no WASM) |
| Limitations | Remove WebP encoding limitation |
| Limitations | Remove AVIF WASM limitation |
| Limitations | Remove 8000x8000 limitation (or note improved) |
| Configuration | Update dependency mention |
| Project layout | Remove avif-plugin.ts and jimp.ts from tree |

### Step 9: Type Check

**Command**: `npm run typecheck` | **Priority**: HIGH | **Effort**: 2 min

```bash
npm run typecheck
# Fix any type errors, particularly:
# - sharp metadata types (width/height are nullable)
# - Remove JimpLike interface and related casts
```

Common fixes needed:
- `metadata.width` and `metadata.height` are `number | undefined` in sharp types
- Use non-null assertions (`!`) or guards after `enforceDimensionLimits`

### Step 10: Run Tests

**Command**: `npm test` | **Priority**: HIGH | **Effort**: 10 min

```bash
npm test
# All tests should pass. Common issues:
# - Output dimensions may differ slightly from Jimp (rounding)
# - AVIF quality mapping differs (visual output may vary)
# - GIF output may differ (sharp uses libvips GIF encoder)
```

### Step 11: E2E Verification

**Priority**: HIGH | **Effort**: 10 min

```bash
npm run build
npm start &

# PNG -> JPEG
curl -X POST "http://localhost:3028/v1/convert?format=jpeg" \
  -F "data=@tests/fixtures/sample.png" -o /tmp/test.jpg
file /tmp/test.jpg  # expect: JPEG image data

# PNG -> AVIF
curl -X POST "http://localhost:3028/v1/convert?format=avif" \
  -F "data=@tests/fixtures/sample.png" -o /tmp/test.avif
file /tmp/test.avif  # expect: AVIF image data

# PNG -> WebP (NEW!)
curl -X POST "http://localhost:3028/v1/convert?format=webp" \
  -F "data=@tests/fixtures/sample.png" -o /tmp/test.webp
file /tmp/test.webp  # expect: WebP image data

# AVIF -> JPEG
curl -X POST "http://localhost:3028/v1/convert?format=jpeg" \
  -F "data=@tests/fixtures/sample.avif" -o /tmp/test2.jpg
file /tmp/test2.jpg  # expect: JPEG image data

# Verify response headers
curl -X POST "http://localhost:3028/v1/convert?format=webp" \
  -F "data=@tests/fixtures/sample.png" -D -
# Expect: X-Input-Mime: image/png, X-Output-Mime: image/webp

kill %1
```


---

## 7. Unchanged Files

| File | Reason |
|------|--------|
| `src/app.ts` | App factory, no Jimp dependency |
| `src/server.ts` | Entry point, no Jimp dependency |
| `src/types.ts` | Shared types, image-engine agnostic |
| `src/plugins/error-handler.ts` | Error class names unchanged, mapping logic unchanged |
| `src/routes/convert.ts` | Only calls `convertImage()`, interface unchanged |
| `src/routes/health.ts` | Health check, unrelated |
| `tsconfig.json` | No sharp-specific config needed |
| `vitest.config.ts` | No config changes needed |

---

## 8. Risk Assessment and Rollback

### 8.1 Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| sharp binary incompatible with target platform | Low | High | Verify `sharp.versions` after install; prebuilt binaries cover all major platforms |
| Output dimensions differ from Jimp (rounding) | Medium | Low | Tests use exact dimension assertions; may need minor adjustments |
| AVIF visual quality differs (sharp vs @jsquash/avif) | Medium | Low | Different encoder libraries; quality=85 may produce slightly different output |
| GIF output format differences | Low | Low | sharp uses libvips GIF encoder; output may differ byte-for-byte |
| sharp metadata.format returns unexpected value | Low | Medium | Add fallback in formatToMime() for unknown formats |
| Node.js version < 20.9.0 in deployment | Low | High | engines field enforced; CI/CD should check |

### 8.2 Rollback Plan

If migration fails, rollback is straightforward:

```bash
# 1. Revert package.json
git checkout HEAD~1 -- package.json

# 2. Restore deleted files
git checkout HEAD~1 -- src/services/avif-plugin.ts src/services/jimp.ts

# 3. Revert converter.ts
git checkout HEAD~1 -- src/services/converter.ts

# 4. Revert config and routes
git checkout HEAD~1 -- src/config/formats.ts src/routes/formats.ts

# 5. Revert tests
git checkout HEAD~1 -- tests/

# 6. Reinstall
rm -rf node_modules package-lock.json
npm install
```

### 8.3 Partial Migration Strategy

If full migration is too risky, consider incremental approach:

1. **Phase 1**: Add sharp alongside Jimp (both available)
2. **Phase 2**: Add feature flag `USE_SHARP=true` to switch engine
3. **Phase 3**: Test with sharp in staging
4. **Phase 4**: Remove Jimp once confident

---

## 9. Post-Migration Format Support Matrix

| Direction | PNG | JPEG | BMP | TIFF | GIF | AVIF | WebP |
|-----------|-----|------|-----|------|-----|------|------|
| Read | YES | YES | YES | YES | YES | YES (native) | YES |
| Write | YES | YES | YES | YES | YES | YES (native) | YES (NEW) |

All formats powered by sharp (native libvips C bindings). No WASM dependencies.

---

## 10. FunctionGraph Deployment Impact

### 10.1 Before Migration

```
n8n -> APIG -> FunctionGraph (container image)
                      ├── Fastify + Jimp + @jsquash/avif (WASM)
                      ├── Cold start: 2-5s (WASM init)
                      └── WebP output: 415 error
```

Workarounds needed:
- Reserved instances (extra cost ~30-80 RMB/month)
- OR Timer-based warmup (complexity)
- OR Split AVIF into separate function (complexity)

### 10.2 After Migration

```
n8n -> APIG -> FunctionGraph (container image)
                      ├── Fastify + sharp (native libvips)
                      ├── Cold start: ~0s (native binary)
                      └── WebP output: 200 OK
```

No workarounds needed:
- Pure on-demand mode (0 RMB idle cost)
- No WASM cold start
- WebP encoding supported
- Better performance = lower execution time = lower cost

### 10.3 Cost Comparison

| Metric | Before | After |
|--------|--------|-------|
| Idle cost (on-demand) | 0 RMB | 0 RMB |
| Cold start workaround | ~30-80 RMB/month (reserved) | 0 RMB |
| Per-request cost | Higher (longer execution) | Lower (4-25x faster) |
| WebP support | Not available | Included at no extra cost |

### 10.4 Deployment Checklist (Post-Migration)

1. Build Docker image with sharp native binary
2. Push to SWR (Huawei Cloud Container Registry)
3. Create FunctionGraph custom image function
4. Configure APIG trigger for `/v1/convert`
5. Set memory to 512MB (sufficient for most images)
6. Set timeout to 30s
7. Test all conversion paths
8. Configure health check on `/health`

```dockerfile
# Suggested Dockerfile for FunctionGraph
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
EXPOSE 8000
ENV PORT=8000
CMD ["node", "dist/server.js"]
```

---

## 11. Summary

| Aspect | Before | After |
|--------|--------|-------|
| Image engine | Jimp + @jsquash/avif (WASM) | sharp (native libvips) |
| AVIF cold start | 2-5s | ~0s |
| WebP encoding | Not supported | Native |
| Performance | Baseline | 4-25x faster |
| Dependencies | 3 packages | 1 package |
| Large images | 8000x8000 limit | Stream-based, no limit |
| FunctionGraph cost | Reserved instance needed | On-demand, 0 idle |
| API interface | - | Unchanged (transparent) |
| Files changed | - | 6 modified, 2 deleted |
| Files unchanged | - | 7 files |
| Estimated effort | - | ~90 minutes |

### Execution Order

```
Step 1 (deps) -> Step 2 (delete) -> Step 3 (rewrite core) -> Step 4 (formats config)
-> Step 5 (formats route) -> Step 6 (tests) -> Step 7 (fixture) -> Step 8 (docs)
-> Step 9 (typecheck) -> Step 10 (test) -> Step 11 (e2e)
```

### Files Changed Summary

| File | Action | Priority |
|------|--------|----------|
| `package.json` | Modify | HIGH |
| `src/services/avif-plugin.ts` | Delete | HIGH |
| `src/services/jimp.ts` | Delete | HIGH |
| `src/services/converter.ts` | Rewrite | HIGH |
| `src/config/formats.ts` | Modify | HIGH |
| `src/routes/formats.ts` | Modify | MEDIUM |
| `tests/app.test.ts` | Modify | HIGH |
| `tests/setup.ts` | Modify | MEDIUM |
| `README.md` | Modify | MEDIUM |
| `src/app.ts` | No change | - |
| `src/server.ts` | No change | - |
| `src/types.ts` | No change | - |
| `src/plugins/error-handler.ts` | No change | - |
| `src/routes/convert.ts` | No change | - |
| `src/routes/health.ts` | No change | - |
