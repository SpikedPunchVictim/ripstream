import {
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

const TYPES = [
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/font-sfnt",
  "application/x-font-adobe-metric",
  "application/x-font-printer-metric",
];

/** TrueType/OpenType name/head/hhea/OS2 metadata and AFM/PFM text metrics. */
export class FontParser implements Parser {
  readonly name = "FontParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(TYPES.map((type) => MediaType.parse(type)!));
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
    const text = new TextDecoder("latin1").decode(data);
    if (text.startsWith("StartFontMetrics") || text.includes("FontName ")) {
      parseMetrics(text, metadata);
      return;
    }
    parseSfnt(data, metadata);
  }
}

function parseSfnt(data: Uint8Array, metadata: Metadata): void {
  if (data.length < 12) throw new MalformedDocumentError("Truncated font");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint32(0);
  if (![0x00010000, 0x4f54544f, 0x74746366].includes(version)) {
    throw new MalformedDocumentError("Not a TrueType/OpenType font");
  }
  const count = view.getUint16(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < count; index++) {
    const entry = 12 + index * 16;
    if (entry + 16 > data.length) break;
    const tag = String.fromCharCode(...data.subarray(entry, entry + 4));
    tables.set(tag, {
      offset: view.getUint32(entry + 8),
      length: view.getUint32(entry + 12),
    });
  }
  const names = tables.get("name");
  if (names !== undefined) parseNameTable(data, view, names, metadata);
  const head = tables.get("head");
  if (head !== undefined && head.offset + 20 <= data.length) {
    metadata.set("font:units-per-em", String(view.getUint16(head.offset + 18)));
  }
  const hhea = tables.get("hhea");
  if (hhea !== undefined && hhea.offset + 8 <= data.length) {
    metadata.set("font:ascender", String(view.getInt16(hhea.offset + 4)));
    metadata.set("font:descender", String(view.getInt16(hhea.offset + 6)));
  }
  const os2 = tables.get("OS/2");
  if (os2 !== undefined && os2.offset + 6 <= data.length) {
    metadata.set("font:weight", String(view.getUint16(os2.offset + 4)));
  }
}

function parseNameTable(
  data: Uint8Array,
  view: DataView,
  table: { offset: number; length: number },
  metadata: Metadata,
): void {
  if (table.offset + 6 > data.length) return;
  const count = view.getUint16(table.offset + 2);
  const strings = table.offset + view.getUint16(table.offset + 4);
  const ids: Record<number, string> = {
    1: "font:family",
    2: "font:subfamily",
    4: "font:full-name",
    6: "font:postscript-name",
  };
  for (let index = 0; index < count && index < 1000; index++) {
    const record = table.offset + 6 + index * 12;
    if (record + 12 > data.length) break;
    const platform = view.getUint16(record);
    const nameId = view.getUint16(record + 6);
    const key = ids[nameId];
    if (key === undefined) continue;
    const length = view.getUint16(record + 8);
    const start = strings + view.getUint16(record + 10);
    if (start + length > data.length) continue;
    const bytes = data.subarray(start, start + length);
    const value =
      platform === 3 || platform === 0
        ? decodeUtf16Be(bytes)
        : new TextDecoder("latin1").decode(bytes);
    if (value.trim().length > 0 && metadata.get(key) === null) {
      metadata.set(key, value.trim());
    }
  }
}

function decodeUtf16Be(bytes: Uint8Array): string {
  let value = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    value += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
  }
  return value;
}

function parseMetrics(text: string, metadata: Metadata): void {
  const fields: Record<string, string> = {
    FontName: "font:postscript-name",
    FullName: "font:full-name",
    FamilyName: "font:family",
    Weight: "font:weight",
    ItalicAngle: "font:italic-angle",
  };
  let matched = false;
  for (const line of text.split(/\r?\n/)) {
    // Manual split: a regex with \s+(.+)$ backtracks quadratically.
    const trimmed = line.trim();
    const split = trimmed.search(/\s/);
    if (split <= 0) continue;
    const name = trimmed.slice(0, split);
    if (!/^[A-Za-z]+$/.test(name)) continue;
    const key = fields[name];
    if (key !== undefined) {
      metadata.set(key, trimmed.slice(split).trim());
      matched = true;
    }
  }
  if (!matched) {
    throw new MalformedDocumentError("Empty font metrics");
  }
}
