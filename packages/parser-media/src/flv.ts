import {
  MalformedDocumentError,
  MediaType,
  javaDoubleString,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** Tags are type byte, 24-bit data size, timestamp, stream id, then the payload and the previous tag size. */
const TAG_HEADER_SIZE = 11;
const TAG_METADATA = 0x12;
const MASK_AUDIO = 1;
const MASK_VIDEO = 4;
const MAX_AMF_DEPTH = 64;
const MAX_AMF_ELEMENTS = 100_000;

/**
 * FLV header and onMetaData (AMF0). It writes the header's audio and video flags as `flv:hasAudio`/`flv:hasVideo` and
 * every scalar onMetaData entry as `flv:<key>`, under the keys Tika's FLVParser writes.
 */
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
    if (data.length < 13 || String.fromCharCode(data[0]!, data[1]!, data[2]!) !== "FLV") {
      throw new MalformedDocumentError("Not an FLV file");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data[3] !== 1) throw new MalformedDocumentError(`Unexpected FLV version: ${data[3]}`);
    const typeFlags = data[4]!;
    if (view.getUint32(5) !== 9) throw new MalformedDocumentError("Unexpected FLV header length");
    if (view.getUint32(9) !== 0) throw new MalformedDocumentError("Unexpected FLV first previous tag size");
    metadata.set("flv:hasAudio", (typeFlags & MASK_AUDIO) !== 0 ? "true" : "false");
    metadata.set("flv:hasVideo", (typeFlags & MASK_VIDEO) !== 0 ? "true" : "false");

    let position = 13;
    while (position + TAG_HEADER_SIZE <= data.length) {
      const type = data[position]!;
      const size = (data[position + 1]! << 16) | (data[position + 2]! << 8) | data[position + 3]!;
      const payload = position + TAG_HEADER_SIZE;
      if (payload + size + 4 > data.length) break;
      if (type === TAG_METADATA && !applyScript(data.subarray(payload, payload + size), metadata)) break;
      if (view.getUint32(payload + size) !== size + TAG_HEADER_SIZE) break;
      position = payload + size + 4;
    }
  }
}

type AmfValue = number | boolean | string | AmfObject | AmfDate | AmfValue[] | null;

interface AmfObject {
  readonly kind: "object";
  readonly entries: ReadonlyMap<string, AmfValue>;
}

interface AmfDate {
  readonly kind: "date";
}
const DATE: AmfDate = { kind: "date" };

function applyScript(data: Uint8Array, metadata: Metadata): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    // The tag is a name ("onMetaData") followed by the metadata object.
    const name = readValue(data, view, 0, 0);
    const value = readValue(data, view, name.position, 0);
    if (value.value === null || typeof value.value !== "object" || Array.isArray(value.value)) return true;
    if (value.value.kind !== "object") return true;
    for (const [key, entry] of value.value.entries) {
      const text = amfText(entry);
      if (text !== null) metadata.add(`flv:${key}`, text);
    }
    return true;
  } catch {
    // Tika aborts the document on a malformed metadata tag, so no later tag is read either.
    return false;
  }
}

/** The value as Java prints it: Double.toString, Boolean.toString, or the string itself. Complex values are skipped. */
function amfText(value: AmfValue): string | null {
  if (typeof value === "number") return javaDoubleString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return null;
}

interface AmfRead {
  readonly position: number;
  readonly value: AmfValue;
}

function readValue(data: Uint8Array, view: DataView, position: number, depth: number): AmfRead {
  if (depth > MAX_AMF_DEPTH) throw new Error("AMF nesting too deep");
  const type = data[position]!;
  return readValueOfType(data, view, position + 1, type, depth);
}

function readValueOfType(
  data: Uint8Array,
  view: DataView,
  position: number,
  type: number,
  depth: number,
): AmfRead {
  switch (type) {
    case 0:
      return { position: position + 8, value: view.getFloat64(position, false) };
    case 1:
      return { position: position + 1, value: data[position] === 1 };
    case 2:
      return readString(data, view, position);
    case 3:
      return readObject(data, view, position, depth);
    case 8:
      return readEcmaArray(data, view, position, depth);
    case 10:
      return readStrictArray(data, view, position, depth);
    case 11:
      return { position: position + 10, value: DATE };
    case 13:
      return { position, value: "UNDEFINED" };
    default:
      return { position, value: null };
  }
}

function readString(data: Uint8Array, view: DataView, position: number): AmfRead {
  if (position + 2 > data.length) throw new Error("Truncated AMF string");
  const length = view.getUint16(position);
  const start = position + 2;
  if (start + length > data.length) throw new Error("Truncated AMF string");
  return { position: start + length, value: new TextDecoder().decode(data.subarray(start, start + length)) };
}

function readObject(data: Uint8Array, view: DataView, position: number, depth: number): AmfRead {
  const entries = new Map<string, AmfValue>();
  for (let count = 0; ; count++) {
    if (position + 3 > data.length) throw new Error("Truncated AMF object");
    if (data[position] === 0 && data[position + 1] === 0 && data[position + 2] === 0x09) {
      return { position: position + 3, value: { kind: "object", entries } };
    }
    if (count >= MAX_AMF_ELEMENTS) throw new Error("Too many AMF object entries");
    const key = readString(data, view, position);
    const type = data[key.position]!;
    const value = readValueOfType(data, view, key.position + 1, type, depth + 1);
    entries.set(key.value as string, value.value);
    position = value.position;
  }
}

function readEcmaArray(data: Uint8Array, view: DataView, position: number, depth: number): AmfRead {
  if (position + 4 > data.length) throw new Error("Truncated AMF array");
  const count = view.getUint32(position);
  if (count > MAX_AMF_ELEMENTS) throw new Error("Too many AMF array entries");
  position += 4;
  const entries = new Map<string, AmfValue>();
  for (let i = 0; i < count; i++) {
    const key = readString(data, view, position);
    const type = data[key.position]!;
    const value = readValueOfType(data, view, key.position + 1, type, depth + 1);
    entries.set(key.value as string, value.value);
    position = value.position;
  }
  return { position, value: { kind: "object", entries } };
}

function readStrictArray(data: Uint8Array, view: DataView, position: number, depth: number): AmfRead {
  if (position + 4 > data.length) throw new Error("Truncated AMF array");
  const count = view.getUint32(position);
  if (count > MAX_AMF_ELEMENTS) throw new Error("Too many AMF array entries");
  position += 4;
  const values: AmfValue[] = [];
  for (let i = 0; i < count; i++) {
    const item = readValue(data, view, position, depth + 1);
    values.push(item.value);
    position = item.position;
  }
  return { position, value: values };
}
