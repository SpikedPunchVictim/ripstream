import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";

/*
 * The Vorbis comment header and the FLAC picture block that Tika's OggAudioParser reads out of the comments of an Ogg
 * file (rawFields, PictureBlock.parse, and the JDK's Base64.getMimeDecoder for the block). Read from that source; not
 * run against a Tika.
 */

/** Real files have a few dozen comments. More than this is refused rather than turned into metadata. */
const MAX_COMMENTS = 10_000;

export interface VorbisComments {
  readonly vendor: string;
  /** The values of each comment field, by lower case name, in the order of the file. */
  readonly fields: ReadonlyMap<string, readonly string[]>;
}

// ignoreBOM: a byte order mark is kept, as Java's decoder keeps it.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * A comment header: `prefixLength` bytes of codec marker, the vendor, then the comments, each with a 32 bit
 * little-endian length. A comment without an equals sign is left out. Every length is checked against the bytes
 * present before it is used.
 */
export function parseComments(packet: Uint8Array, prefixLength: number): VorbisComments {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let position = prefixLength;
  const length = (what: string): number => {
    if (position + 4 > packet.length) throw new MalformedDocumentError(`The comment header ends inside ${what}`);
    position += 4;
    return view.getUint32(position - 4, true);
  };
  const text = (size: number, what: string): string => {
    if (size > packet.length - position) throw new MalformedDocumentError(`The comment header declares ${what} of ${size} bytes in ${packet.length - position}`);
    position += size;
    return utf8.decode(packet.subarray(position - size, position));
  };

  const vendor = text(length("the vendor length"), "a vendor");
  const count = length("the comment count");
  // Each comment takes at least its 4 byte length, so a count that the rest of the header cannot hold is a lie.
  if (count * 4 > packet.length - position) {
    throw new MalformedDocumentError(`The comment header declares ${count} comments in ${packet.length - position} bytes`);
  }
  if (count > MAX_COMMENTS) throw new LimitExceededError(`The comment header declares ${count} comments, more than ${MAX_COMMENTS}`);

  const fields = new Map<string, string[]>();
  for (let index = 0; index < count; index++) {
    const comment = text(length("a comment length"), "a comment");
    const equals = comment.indexOf("=");
    if (equals < 0) continue;
    const name = comment.slice(0, equals).toLowerCase();
    const values = fields.get(name);
    if (values === undefined) fields.set(name, [comment.slice(equals + 1)]);
    else values.push(comment.slice(equals + 1));
  }
  return { vendor, fields };
}

export interface PictureBlock {
  readonly type: number;
  readonly mimeType: string;
  readonly description: string;
  readonly data: Uint8Array;
}

/**
 * A FLAC picture block: a 32 bit big-endian picture type, the mime type and the description (each with a length in
 * front), 16 bytes of picture geometry, then the picture with its length in front. Null for a block that stops short,
 * declares more than it holds, has no picture, or links to one (mime type "-->") instead of holding it.
 */
export function parsePictureBlock(block: Uint8Array): PictureBlock | null {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  let position = 0;
  const int = (): number | null => {
    if (position + 4 > block.length) return null;
    position += 4;
    return view.getInt32(position - 4);
  };
  const prefixed = (decode: (bytes: Uint8Array) => string): string | null => {
    const size = int();
    if (size === null || size < 0 || size > block.length - position) return null;
    position += size;
    return decode(block.subarray(position - size, position));
  };

  const type = int();
  const mimeType = prefixed(latin1);
  if (type === null || mimeType === null || mimeType === "-->") return null;
  const description = prefixed((bytes) => utf8.decode(bytes));
  if (description === null) return null;
  position += 16;
  const size = int();
  if (size === null || size <= 0 || size > block.length - position) return null;
  return { type, mimeType, description, data: block.slice(position, position + size) };
}

/** ISO-8859-1. TextDecoder's "latin1" is windows-1252, which differs in 0x80 to 0x9f. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

const SEXTETS = new Int8Array(128).fill(-1);
for (const [index, char] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries()) {
  SEXTETS[char.charCodeAt(0)] = index;
}

/**
 * Base64.getMimeDecoder().decode(String): characters outside the alphabet are skipped (line breaks, spaces, and also
 * the URL-safe - and _), the last unit may stop short of its padding, and a dangling sextet, padding where no bits are
 * pending, a single = where two are needed, or alphabet characters after the padding are refused with null. Characters
 * above 255 are '?' to the JDK, which skips them too.
 */
export function decodeMimeBase64(text: string): Uint8Array | null {
  const out = new Uint8Array(Math.ceil((text.length * 3) / 4));
  let length = 0;
  let bits = 0;
  let shift = 18;
  let position = 0;
  while (position < text.length) {
    const code = text.charCodeAt(position++);
    const sextet = code < 128 ? SEXTETS[code]! : -1;
    if (sextet < 0) {
      if (code !== 0x3d) continue;
      const needsSecondPad = shift === 6 && (position === text.length || text.charCodeAt(position++) !== 0x3d);
      if (needsSecondPad || shift === 18) return null;
      break;
    }
    bits |= sextet << shift;
    shift -= 6;
    if (shift < 0) {
      out[length++] = (bits >> 16) & 0xff;
      out[length++] = (bits >> 8) & 0xff;
      out[length++] = bits & 0xff;
      shift = 18;
      bits = 0;
    }
  }
  if (shift === 6) {
    out[length++] = (bits >> 16) & 0xff;
  } else if (shift === 0) {
    out[length++] = (bits >> 16) & 0xff;
    out[length++] = (bits >> 8) & 0xff;
  } else if (shift === 12) {
    return null;
  }
  // After the padding only characters outside the alphabet may follow.
  for (; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code < 128 && SEXTETS[code]! >= 0) return null;
  }
  return out.slice(0, length);
}

export interface FlacStreamInfo {
  readonly sampleRate: number;
  readonly channels: number;
  /** Zero when the encoder did not know it. */
  readonly totalSamples: number;
}

/**
 * The STREAMINFO block of FLAC (RFC 9639, section 8.2) from its `offset`: after 10 bytes of block and frame sizes, 20 bits
 * of sample rate, 3 of channels less one, 5 of bits per sample less one, and 36 of total samples. The caller has checked
 * that the 18 bytes are there. Shared by native FLAC and the mapping of FLAC into Ogg.
 */
export function readFlacStreamInfo(bytes: Uint8Array, offset: number): FlacStreamInfo {
  const at = (index: number): number => bytes[offset + index]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    sampleRate: (at(10) << 12) | (at(11) << 4) | (at(12) >> 4),
    channels: ((at(12) >> 1) & 7) + 1,
    totalSamples: (at(13) & 0x0f) * 2 ** 32 + view.getUint32(offset + 14),
  };
}
