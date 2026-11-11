import { MalformedDocumentError, type Metadata, type RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { INT32_MAX, setImageReaderMetadata } from "./imageio-metadata.ts";

/** The magic number, the two sizes and any comments before them. A comment that fills this is refused. */
const HEADER_WINDOW = 4096;
/** 2^31-1 has 10 digits. */
const MAX_DIGITS = 10;

/**
 * PPM (and, by the same header, the other netpbm formats): `P1` to `P6`, whitespace, width, height, as decimal numbers
 * separated by whitespace, with `#` comments to the end of the line allowed anywhere in the header. Tika's
 * ImageParser gives `image/x-portable-pixmap` to javax.imageio, where jai-imageio-core's PNM reader is the one that
 * reads it; its source is not in Tika's tree, so this follows the netpbm header format, and writes the keys
 * ImageParser writes for the first image (see `setImageReaderMetadata`). The reader's own IIOMetadata attributes are
 * not written.
 *
 * Refused: a number of more than 10 digits or beyond int32, a size of zero, a header that does not end within 4096
 * bytes.
 */
export async function readPnm(stream: RipstreamInputStream, metadata: Metadata): Promise<void> {
  const head = await stream.peek(HEADER_WINDOW);
  const magic = head[1];
  if (head.length < 3 || head[0] !== 0x50 || magic === undefined || magic < 0x31 || magic > 0x36 || !isSpace(head[2]!)) {
    throw new MalformedDocumentError("Not a PNM image: expected P1 to P6 and a whitespace");
  }
  const width = readNumber(head, 2);
  const height = readNumber(head, width.next);
  if (width.value <= 0 || height.value <= 0) {
    throw new MalformedDocumentError(`PNM image size ${width.value}x${height.value} is not positive`);
  }
  // The reader decodes the first image of the stream and no more.
  setImageReaderMetadata(metadata, width.value, height.value, 1);
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

/** Skips whitespace and comments, then reads digits that a whitespace must follow (or a cut number would be believed). */
function readNumber(head: Uint8Array, from: number): { value: number; next: number } {
  let position = from;
  while (position < head.length) {
    if (isSpace(head[position]!)) {
      position++;
    } else if (head[position] === 0x23) {
      while (position < head.length && head[position] !== 0x0a && head[position] !== 0x0d) position++;
    } else {
      break;
    }
  }
  const start = position;
  while (position < head.length && head[position]! >= 0x30 && head[position]! <= 0x39) position++;
  if (position === start) throw new MalformedDocumentError("PNM header: a number was expected");
  if (position - start > MAX_DIGITS) throw new MalformedDocumentError("PNM header: a number of more than 10 digits");
  if (position >= head.length || !isSpace(head[position]!)) {
    throw new MalformedDocumentError("PNM header: a number is not followed by whitespace");
  }
  const value = Number(String.fromCharCode(...head.subarray(start, position)));
  if (value > INT32_MAX) throw new MalformedDocumentError("PNM header: a number beyond int32");
  return { value, next: position };
}
