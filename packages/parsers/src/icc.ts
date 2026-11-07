import {
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** ICC profile header and description metadata. */
export class IccParser implements Parser {
  readonly name = "ICCParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/vnd.iccprofile")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
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
    if (data.length < 132) throw new MalformedDocumentError("Truncated ICC profile");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const declared = view.getUint32(0, false);
    if (declared > data.length || declared < 128) {
      throw new MalformedDocumentError("Invalid ICC profile size");
    }
    const version = `${data[8]}.${data[9]}`;
    const profileClass = ascii(data, 12, 4);
    const colorSpace = ascii(data, 16, 4);
    const pcs = ascii(data, 20, 4);
    const description = findDescription(data, view);

    metadata.set("icc:version", version);
    metadata.set("icc:class", profileClass);
    metadata.set("icc:color-space", colorSpace);
    metadata.set("icc:pcs", pcs);
    if (description !== null) metadata.set("icc:description", description);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.element("p", `ICC version: ${version}`);
    await xhtml.element("p", `Class: ${profileClass}`);
    await xhtml.element("p", `Color space: ${colorSpace}`);
    if (description !== null) await xhtml.element("p", `Description: ${description}`);
    await xhtml.endDocument();
  }
}

function findDescription(data: Uint8Array, view: DataView): string | null {
  const count = view.getUint32(128, false);
  if (count > 1_000 || 132 + count * 12 > data.length) return null;
  for (let index = 0; index < count; index++) {
    const entry = 132 + index * 12;
    if (ascii(data, entry, 4) !== "desc") continue;
    const offset = view.getUint32(entry + 4, false);
    const size = view.getUint32(entry + 8, false);
    if (offset + size > data.length || offset + 12 > data.length) return null;
    const type = ascii(data, offset, 4);
    if (type === "desc") {
      const length = view.getUint32(offset + 8, false);
      return ascii(data, offset + 12, Math.min(length, size - 12)).replace(/\0+$/, "").trim();
    }
    if (type === "mluc") {
      const records = view.getUint32(offset + 8, false);
      if (records === 0) return null;
      const length = view.getUint32(offset + 20, false);
      const position = view.getUint32(offset + 24, false);
      let result = "";
      for (let i = 0; i + 1 < length; i += 2) {
        result += String.fromCharCode(view.getUint16(offset + position + i, false));
      }
      return result.trim();
    }
    return null;
  }
  return null;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index++) {
    value += String.fromCharCode(data[offset + index] ?? 0);
  }
  return value.trim();
}
