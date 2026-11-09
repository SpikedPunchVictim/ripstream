import { MediaType } from "@spikedpunch/ripstream-core";

const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3];
const HEADER_BYTES = 64;
const WEBM = MediaType.parse("video/webm") as MediaType;
const MATROSKA = MediaType.parse("application/x-matroska") as MediaType;

/**
 * Port of Tika 4.2.0's `MatroskaDetector`: an EBML header, then the first `webm` or `matr` (as in `matroska`) found
 * in the first 64 bytes names the doctype. Null when the bytes are not an EBML header or name neither.
 */
export function detectMatroska(prefix: Uint8Array): MediaType | null {
  const header = prefix.subarray(0, HEADER_BYTES);
  if (header.length < EBML_HEADER.length) return null;
  if (!EBML_HEADER.every((byte, index) => header[index] === byte)) return null;

  for (let index = 4; index < header.length - 4; index++) {
    if (matchesAt(header, index, "webm")) return WEBM;
    if (matchesAt(header, index, "matr")) return MATROSKA;
  }
  return null;
}

function matchesAt(data: Uint8Array, index: number, text: string): boolean {
  for (let offset = 0; offset < text.length; offset++) {
    if (data[index + offset] !== text.charCodeAt(offset)) return false;
  }
  return true;
}
