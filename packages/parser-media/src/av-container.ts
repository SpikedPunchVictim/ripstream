import {
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** AVI (RIFF) metadata. */
export class AviParser implements Parser {
  readonly name = "AVIParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(["video/x-msvideo", "video/avi"].map((type) => MediaType.parse(type)!));
  }

  async parse(stream: RipstreamInputStream, _handler: ContentHandler, metadata: Metadata, _ctx: ParseContext): Promise<void> {
    const data = await readAll(stream);
    if (ascii(data, 0, 4) !== "RIFF" || ascii(data, 8, 4) !== "AVI ") {
      throw new MalformedDocumentError("Not an AVI file");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (!readAviHeader(data, view, 12, data.length, metadata, 0)) {
      throw new MalformedDocumentError("Missing AVI header chunk");
    }
  }
}

const MAX_RIFF_DEPTH = 8;

/** Walks RIFF chunks, descending into LIST chunks (avih lives in LIST hdrl). */
function readAviHeader(
  data: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  metadata: Metadata,
  depth: number,
): boolean {
  for (let offset = start; offset + 8 <= end; ) {
    const id = ascii(data, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > end) break;
    if (id === "avih") {
      if (size < 40) throw new MalformedDocumentError("Truncated AVI header chunk");
      const base = offset + 8;
      const microsPerFrame = view.getUint32(base, true);
      const totalFrames = view.getUint32(base + 16, true);
      metadata.set("tiff:ImageWidth", String(view.getUint32(base + 32, true)));
      metadata.set("tiff:ImageLength", String(view.getUint32(base + 36, true)));
      metadata.set("audio:spi-duration", String((microsPerFrame * totalFrames) / 1_000_000));
      return true;
    }
    // LIST payload: 4-byte list type, then sub-chunks. movi holds only frame data.
    if (id === "LIST" && size >= 4 && depth < MAX_RIFF_DEPTH && ascii(data, offset + 8, 4) !== "movi") {
      if (readAviHeader(data, view, offset + 12, offset + 8 + size, metadata, depth + 1)) return true;
    }
    offset += 8 + size + (size % 2);
  }
  return false;
}

/** Matroska/WebM EBML metadata. */
export class MatroskaParser implements Parser {
  readonly name = "MatroskaParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(["video/x-matroska", "application/x-matroska", "video/webm", "audio/x-matroska"].map((type) => MediaType.parse(type)!));
  }

  async parse(stream: RipstreamInputStream, _handler: ContentHandler, metadata: Metadata, _ctx: ParseContext): Promise<void> {
    const data = await readAll(stream);
    if (data.length < 4 || data[0] !== 0x1a || data[1] !== 0x45 || data[2] !== 0xdf || data[3] !== 0xa3) {
      throw new MalformedDocumentError("Not a Matroska file");
    }
    walkEbml(data, 0, data.length, metadata, 0);
    if (metadata.get("audio:spi-duration") === null && metadata.get("tiff:ImageWidth") === null) {
      throw new MalformedDocumentError("No Matroska metadata");
    }
  }
}

/** ASF/WMV header metadata. */
export class AsfParser implements Parser {
  readonly name = "ASFParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(["video/x-ms-asf", "video/x-ms-wmv", "audio/x-ms-wma"].map((type) => MediaType.parse(type)!));
  }

  async parse(stream: RipstreamInputStream, _handler: ContentHandler, metadata: Metadata, _ctx: ParseContext): Promise<void> {
    const data = await readAll(stream);
    const signature = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
    if (!signature.every((byte, index) => data[index] === byte)) {
      throw new MalformedDocumentError("Not an ASF file");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 30) throw new MalformedDocumentError("Truncated ASF header");
    const headerSize = Number(view.getBigUint64(16, true));
    let offset = 30;
    // The ASF object size includes its own 24-byte header.
    const end = Math.min(headerSize, data.length);
    const fileProperties = [0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65];
    while (offset + 24 <= end) {
      const guid = [...data.subarray(offset, offset + 16)];
      const size = Number(view.getBigUint64(offset + 16, true));
      if (guid.every((byte, index) => byte === fileProperties[index])) {
        const base = offset + 24;
        if (base + 64 > data.length) {
          throw new MalformedDocumentError("Truncated ASF file properties");
        }
        const playDuration = Number(view.getBigUint64(base + 40, true));
        const preroll = Number(view.getBigUint64(base + 56, true));
        metadata.set("audio:spi-duration", String(playDuration / 10_000_000 - preroll / 1000));
        return;
      }
      if (size < 24) break;
      offset += size;
    }
    throw new MalformedDocumentError("Missing ASF file properties");
  }
}

async function readAll(stream: RipstreamInputStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

const MAX_EBML_DEPTH = 64;

function walkEbml(data: Uint8Array, start: number, end: number, metadata: Metadata, depth: number): void {
  if (depth > MAX_EBML_DEPTH) {
    throw new MalformedDocumentError(`EBML nesting exceeds ${MAX_EBML_DEPTH} levels`);
  }
  let offset = start;
  while (offset < end) {
    const id = readVint(data, offset, true);
    if (id === null) return;
    const size = readVint(data, id.next, false);
    if (size === null) return;
    const descend =
      id.value === 0x18538067 || // Segment
      id.value === 0x1549a966 || // Info
      id.value === 0x1654ae6b || // Tracks
      id.value === 0xae || // TrackEntry
      id.value === 0xe0; // Video
    // Unknown-size (all-ones) elements run to the end of the parent. We can only
    // follow that for master elements we descend into; anything else is unskippable.
    if (size.unknown && !descend) return;
    if (!size.unknown && size.next + size.value > end) return;
    const content = size.next;
    const contentEnd = size.unknown ? end : content + size.value;
    if (descend) {
      walkEbml(data, content, contentEnd, metadata, depth + 1);
    } else if (id.value === 0x4489 && (size.value === 4 || size.value === 8)) {
      const view = new DataView(data.buffer, data.byteOffset);
      const duration = size.value === 4 ? view.getFloat32(content) : view.getFloat64(content);
      if (Number.isFinite(duration)) metadata.set("audio:spi-duration", String(duration / 1000));
    } else if (id.value === 0xb0 && size.value <= 4) {
      metadata.set("tiff:ImageWidth", String(readUInt(data, content, size.value)));
    } else if (id.value === 0xba && size.value <= 4) {
      metadata.set("tiff:ImageLength", String(readUInt(data, content, size.value)));
    }
    offset = contentEnd;
  }
}

function readVint(
  data: Uint8Array,
  offset: number,
  keepMarker: boolean,
): { value: number; next: number; unknown: boolean } | null {
  if (offset >= data.length) return null;
  const first = data[offset]!;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > data.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let index = 1; index < length; index++) {
    value = value * 256 + data[offset + index]!;
    if (data[offset + index] !== 0xff) allOnes = false;
  }
  return { value, next: offset + length, unknown: !keepMarker && allOnes };
}

function readUInt(data: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let index = 0; index < length; index++) value = value * 256 + data[offset + index]!;
  return value;
}
