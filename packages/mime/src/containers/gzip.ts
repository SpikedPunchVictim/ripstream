import { MediaType } from "@spikedpunch/ripstream-core";
import { gunzipPrefix } from "./inflate-prefix.ts";

const GZIP = MediaType.parse("application/gzip") as MediaType;
const WARC_GZ = MediaType.parse("application/warc+gz") as MediaType;
const ARC_GZ = MediaType.parse("application/arc+gz") as MediaType;

/** Tika inflates the first 1024 compressed bytes; the longest marker checked is 11 bytes. */
const COMPRESSED_BYTES = 1024;
const MARKER_BYTES = 16;

/**
 * Port of Tika 4.2.0's `GZipSpecializationDetector`: a gzip whose first inflated bytes are `WARC/` is `warc+gz`, one
 * that starts `filedesc://` is `arc+gz`, any other gzip is `application/gzip`. Null when the bytes are not gzip.
 */
export async function detectGzipSpecialization(prefix: Uint8Array): Promise<MediaType | null> {
  if (prefix.length < 2 || prefix[0] !== 0x1f || prefix[1] !== 0x8b) return null;

  const inflated = await gunzipPrefix(prefix.subarray(0, COMPRESSED_BYTES), MARKER_BYTES);
  const text = new TextDecoder("utf-8").decode(inflated);
  if (text.startsWith("WARC/")) return WARC_GZ;
  if (text.startsWith("filedesc://")) return ARC_GZ;
  return GZIP;
}
