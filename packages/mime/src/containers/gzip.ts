import { constants, inflateRawSync } from "node:zlib";
import { MediaType } from "@spikedpunch/ripstream-core";

const GZIP = MediaType.parse("application/gzip") as MediaType;
const WARC_GZ = MediaType.parse("application/warc+gz") as MediaType;
const ARC_GZ = MediaType.parse("application/arc+gz") as MediaType;

/** Tika inflates the first 1024 compressed bytes of the first member. */
const COMPRESSED_BYTES = 1024;
/** Deflate expands at most ~1032:1, so 1 KiB of input cannot produce more than this. */
const MAX_INFLATED_BYTES = 2 * 1024 * 1024;

const FHCRC = 0x02;
const FEXTRA = 0x04;
const FNAME = 0x08;
const FCOMMENT = 0x10;
const FRESERVED = 0xe0;

/**
 * Port of Tika 4.2.0's `GZipSpecializationDetector`: a gzip whose first inflated bytes are `WARC/` is `warc+gz`, one
 * that starts `filedesc://` is `arc+gz`, any other gzip is `application/gzip`. Null when the bytes are not gzip.
 *
 * Only the first member is read (commons-compress is not asked to join members), and its trailer is not checked: Tika
 * reads byte by byte until the stream fails, so the text before a bad CRC or trailing junk still counts. The deflate
 * body is inflated directly after the header is skipped, because zlib's gzip stream drops the output of a call that
 * ends in an error.
 */
export function detectGzipSpecialization(prefix: Uint8Array): MediaType | null {
  if (prefix.length < 2 || prefix[0] !== 0x1f || prefix[1] !== 0x8b) return null;

  const window = prefix.subarray(0, COMPRESSED_BYTES);
  const bodyStart = skipHeader(window);
  if (bodyStart === null) return GZIP;

  let inflated: Uint8Array;
  try {
    inflated = inflateRawSync(window.subarray(bodyStart), {
      finishFlush: constants.Z_SYNC_FLUSH,
      maxOutputLength: MAX_INFLATED_BYTES,
    });
  } catch {
    return GZIP;
  }
  // Java's `new String(bytes, UTF_8)` keeps a leading byte-order mark; a TextDecoder drops it unless told not to.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(inflated.subarray(0, 16));
  if (text.startsWith("WARC/")) return WARC_GZ;
  if (text.startsWith("filedesc://")) return ARC_GZ;
  return GZIP;
}

/** The offset of the deflate body, or null when the header is not a deflate gzip header or runs past the window. */
function skipHeader(data: Uint8Array): number | null {
  if (data.length < 10 || data[2] !== 8) return null;
  const flags = data[3]!;
  if ((flags & FRESERVED) !== 0) return null;

  let position = 10;
  if ((flags & FEXTRA) !== 0) {
    if (position + 2 > data.length) return null;
    const extraLength = data[position]! | (data[position + 1]! << 8);
    position += 2;
    // The extra field must tile exactly into subfields (2-byte id, 2-byte length, data); a stray byte or a subfield
    // that overruns it fails the header in Tika (measured: lengths 3 and 6 with one stray byte read as plain gzip).
    const extraEnd = position + extraLength;
    while (position < extraEnd) {
      if (position + 4 > extraEnd) return null;
      position += 4 + (data[position + 2]! | (data[position + 3]! << 8));
      if (position > extraEnd) return null;
    }
  }
  for (const flag of [FNAME, FCOMMENT]) {
    if ((flags & flag) === 0) continue;
    while (position < data.length && data[position] !== 0) position++;
    position++;
  }
  // The header CRC is not verified: Tika reads past a wrong one.
  if ((flags & FHCRC) !== 0) position += 2;
  return position < data.length ? position : null;
}
