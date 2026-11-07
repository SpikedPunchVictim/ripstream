import {
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** FLV header + onMetaData (AMF0) metadata. */
export class FlvParser implements Parser {
  readonly name = "FLVParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("video/x-flv")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    _handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
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
    if (data.length < 9 || String.fromCharCode(data[0]!, data[1]!, data[2]!) !== "FLV") {
      throw new MalformedDocumentError("Not an FLV file");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerSize = view.getUint32(5);
    let position = headerSize + 4;
    while (position + 11 <= data.length) {
      const type = data[position]!;
      const size = (data[position + 1]! << 16) | (data[position + 2]! << 8) | data[position + 3]!;
      const payload = position + 11;
      if (payload + size > data.length) break;
      if (type === 18) {
        applyScript(data.subarray(payload, payload + size), metadata);
      }
      position = payload + size + 4;
    }
  }
}

function applyScript(data: Uint8Array, metadata: Metadata): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let position = 0;
  try {
    position = readValue(data, view, position, undefined, metadata);
    readValue(data, view, position, undefined, metadata);
  } catch {
    // Ignore malformed metadata; other tags may still be readable.
  }
}

function readValue(
  data: Uint8Array,
  view: DataView,
  position: number,
  key: string | undefined,
  metadata: Metadata,
): number {
  const type = data[position]!;
  position++;
  if (type === 0) {
    const value = view.getFloat64(position, false);
    if (key !== undefined) {
      if (key === "duration") metadata.set("xmpDM:duration", String(value));
      else if (key === "width") metadata.set("tiff:ImageWidth", String(value));
      else if (key === "height") metadata.set("tiff:ImageLength", String(value));
      else if (key === "videodatarate") metadata.set("video:bitrate", String(value * 1000));
      else if (key === "framerate") metadata.set("video:frame-rate", String(value));
    }
    return position + 8;
  }
  if (type === 2) {
    const length = view.getUint16(position, false);
    return position + 2 + length;
  }
  if (type === 3 || type === 8) {
    if (type === 8) position += 4;
    for (;;) {
      if (position + 2 > data.length || data[position] === 0 && data[position + 1] === 0 && data[position + 2] === 0x09) {
        return position + 3;
      }
      const length = view.getUint16(position, false);
      const name = new TextDecoder().decode(data.subarray(position + 2, position + 2 + length));
      position = readValue(data, view, position + 2 + length, name, metadata);
    }
  }
  return data.length;
}
