import { MalformedDocumentError, type Metadata, type RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { setImageReaderMetadata } from "./imageio-metadata.ts";

/** A header is 2 bytes and two integers of at most 5 bytes each. */
const HEADER_WINDOW = 64;
/** An integer of more than 5 bytes (35 bits) is no size an int can hold. */
const MAX_INTEGER_BYTES = 5;

/**
 * WBMP (WAP-190 Wireless Bitmap): a type byte and a fixed header byte, both 0, then width and height as multi-byte
 * integers (7 bits per byte, the high bit set on every byte but the last). Tika's ImageParser gives it to
 * javax.imageio's WBMP reader; this reads the same header and writes the keys ImageParser writes for the first image
 * (see `setImageReaderMetadata`). The reader's own IIOMetadata attributes (`img:` colour space, compression and so on)
 * are not written: they come from the Java reader, whose source is not in Tika's.
 *
 * The integer arithmetic is a Java int's, so a size of 2^31 or more wraps negative and is refused, as is a size of
 * zero and an integer of more than 5 bytes.
 */
export async function readWbmp(stream: RipstreamInputStream, metadata: Metadata): Promise<void> {
  const head = await stream.peek(HEADER_WINDOW);
  if (head.length < 2 || head[0] !== 0 || head[1] !== 0) {
    throw new MalformedDocumentError("Not a WBMP image: the type and the fixed header field must both be 0");
  }
  const width = readMultiByteInteger(head, 2);
  const height = readMultiByteInteger(head, width.next);
  if (width.value <= 0 || height.value <= 0) {
    throw new MalformedDocumentError(`WBMP image size ${width.value}x${height.value} is not positive`);
  }
  // A single-image format: getNumImages is 1.
  setImageReaderMetadata(metadata, width.value, height.value, 1);
}

function readMultiByteInteger(head: Uint8Array, from: number): { value: number; next: number } {
  let value = 0;
  let position = from;
  for (let bytes = 1; ; bytes++) {
    if (bytes > MAX_INTEGER_BYTES) throw new MalformedDocumentError("WBMP integer is longer than 5 bytes");
    if (position >= head.length) throw new MalformedDocumentError("Truncated WBMP header");
    const byte = head[position++]!;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      // `<<` is int32 arithmetic, as Java's: a value of 2^31 or more has wrapped negative.
      if (value < 0) throw new MalformedDocumentError("WBMP integer is beyond int32");
      return { value, next: position };
    }
  }
}
