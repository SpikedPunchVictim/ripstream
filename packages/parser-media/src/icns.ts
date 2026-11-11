import {
  LimitExceededError,
  MalformedDocumentError,
  type Metadata,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** ICNSParser.MAX_IMAGE_LENGTH_BYTES: the file after its 8 byte header may not be longer than this. */
const MAX_IMAGE_LENGTH_BYTES = 10_485_760;

/**
 * Not in Tika. ICNSType knows 32 sub-icon types and a real file holds each at most once, but a 10 MiB file can name
 * more than a million, and Tika would build a metadata value of that many entries.
 */
const MAX_SUB_ICONS = 1024;

interface IcnsType {
  readonly width: number;
  readonly height: number;
  readonly bitsPerPixel: number;
  readonly hasMask: boolean;
  readonly retina: boolean;
}

function icon(width: number, height: number, bitsPerPixel: number, hasMask = false, retina = false): IcnsType {
  return { width, height, bitsPerPixel, hasMask, retina };
}

/** ICNSType's `allImageTypes`, by the four characters that open a sub-icon: width, height, bits, mask, retina. */
const ICNS_TYPES: ReadonlyMap<string, IcnsType> = new Map([
  ["ICON", icon(32, 32, 1)],
  ["icm#", icon(16, 12, 1, true)],
  ["icm4", icon(16, 12, 4)],
  ["icm8", icon(16, 12, 8)],
  ["s8mk", icon(16, 16, 8, true)],
  ["ics#", icon(16, 16, 1, true)],
  ["ics4", icon(16, 16, 4)],
  ["ics8", icon(16, 16, 8)],
  ["is32", icon(16, 16, 24)],
  ["l8mk", icon(32, 32, 8, true)],
  ["ICN#", icon(32, 32, 1, true)],
  ["icl4", icon(32, 32, 4)],
  ["icl8", icon(32, 32, 8)],
  ["il32", icon(32, 32, 24)],
  ["h8mk", icon(48, 48, 8, true)],
  ["ich#", icon(48, 48, 1, true)],
  ["ich4", icon(48, 48, 4)],
  ["ich8", icon(48, 48, 8)],
  ["ih32", icon(48, 48, 24)],
  ["t8mk", icon(128, 128, 8, true)],
  ["it32", icon(128, 128, 24)],
  ["icp4", icon(16, 16, 0)],
  ["icp5", icon(32, 32, 0)],
  ["icp6", icon(64, 64, 0)],
  ["icp7", icon(128, 128, 0)],
  ["ic08", icon(256, 256, 0)],
  ["ic09", icon(512, 512, 0)],
  ["ic10", icon(1024, 1024, 0, false, true)],
  ["ic11", icon(16, 16, 0, false, true)],
  ["ic12", icon(32, 32, 0, false, true)],
  ["ic13", icon(128, 128, 0, false, true)],
  ["ic14", icon(256, 256, 0, false, true)],
]);

const MAGIC = [0x69, 0x63, 0x6e, 0x73]; // "icns"

/**
 * Apple ICNS, read as Tika 4.2.0's ICNSParser reads it: the signature, the length of the file, then the chain of
 * sub-icons by their four character type and length. Only the types are looked at; the images are not decoded.
 *
 * Where it differs from Tika: more than 1024 sub-icons are a limit (see MAX_SUB_ICONS), a stream shorter than the 8 byte
 * header is Malformed (Tika reads a header it only half filled), and a length that would take the walk before the start
 * of the file is Malformed (Tika throws ArrayIndexOutOfBoundsException). Tika writes its keys through
 * `Property.externalText`, so they have spaces in them.
 */
export async function readIcns(stream: RipstreamInputStream, metadata: Metadata): Promise<void> {
  const head = await stream.peek(8);
  if (head.length < 4 || MAGIC.some((byte, index) => head[index] !== byte)) {
    throw new MalformedDocumentError("ICNS magic signature invalid");
  }
  if (head.length < 8) throw new MalformedDocumentError("Truncated ICNS header");
  const declared = new DataView(head.buffer, head.byteOffset, head.byteLength).getInt32(4);
  // Java's int: Integer.MIN_VALUE - 8 wraps to a large positive number, which is then a limit, not a negative length.
  const imageLength = (declared - 8) | 0;
  if (imageLength > MAX_IMAGE_LENGTH_BYTES) {
    throw new LimitExceededError(`ICNS image length ${imageLength} exceeds ${MAX_IMAGE_LENGTH_BYTES} bytes`);
  }
  if (imageLength < 0) throw new MalformedDocumentError("ICNS image length must be >= 0");

  // Only the bytes the stream has: a header that claims 10 MiB of a 16 byte file allocates 16 bytes.
  const file = await stream.peek(8 + imageLength);
  if (file.length < 8 + imageLength) {
    throw new MalformedDocumentError(
      `Truncated ICNS: the header declares ${imageLength} bytes after it, ${file.length - 8} are present`,
    );
  }
  const body = file.subarray(8);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

  const icons: IcnsType[] = [];
  const masks: IcnsType[] = [];
  // Tika's bound: an entry whose 8 byte header starts in the last 8 bytes is never looked at.
  for (let offset = 0; offset < imageLength - 8; ) {
    const type = ICNS_TYPES.get(String.fromCharCode(body[offset]!, body[offset + 1]!, body[offset + 2]!, body[offset + 3]!));
    if (type === undefined) break;
    (type.hasMask ? masks : icons).push(type);
    if (icons.length + masks.length > MAX_SUB_ICONS) {
      throw new LimitExceededError(`ICNS names more than ${MAX_SUB_ICONS} sub-icons`);
    }
    const length = view.getInt32(offset + 4);
    if (length <= 0) break;
    offset = (offset + length) | 0;
    if (offset < 0) throw new MalformedDocumentError("ICNS sub-icon length runs outside the file");
  }

  metadata.set("Content-Type", "image/icns");
  if (icons.length > 0) {
    metadata.set("Icon count", icons.length);
    metadata.set("Icon details", icons.map(describeIcon).join(", "));
  }
  if (masks.length > 0) {
    metadata.set("Masked icon count", masks.length);
    metadata.set("Masked icon details", masks.map(describeMask).join(", "));
  }
}

/** Height before width, as Tika prints them; `@2X` for a retina icon; no bit count for a PNG or JPEG 2000 icon. */
function describeIcon(type: IcnsType): string {
  const bits = type.bitsPerPixel !== 0 ? `${type.bitsPerPixel} bpp` : "JPEG 2000 or PNG format";
  const size = `${type.height}x${type.width}${type.retina ? "@2X" : ""}`;
  return `${size} (${bits})`;
}

function describeMask(type: IcnsType): string {
  return `${type.height}x${type.width} (${type.bitsPerPixel} bpp)`;
}
