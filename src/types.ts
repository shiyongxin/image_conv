/**
 * Shared TypeScript types for the image-conversion API.
 *
 * Request shapes that arrive via JSON (base64 mode) live here so the
 * converter service and the route handler can share them.
 */

export interface JsonConvertRequest {
  /**
   * Either a raw base64 string or a data URL ("data:image/png;base64,...").
   * In both cases the leading data URL prefix is stripped before decoding.
   */
  image: string;
  /** Target format identifier (e.g. "png", "jpeg"). */
  format: string;
  /** Optional transformation knobs. */
  options?: {
    quality?: number;
    deflateLevel?: number;
    width?: number;
    height?: number;
    background?: string;
  };
}

/** RFC 7807-style error envelope returned for non-2xx responses. */
export interface ApiErrorBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  invalidParams?: Array<{ name: string; reason: string }>;
}
