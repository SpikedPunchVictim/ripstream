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

/** RAR/7z signature-level metadata without proprietary decompression. */
export class ArchiveMetadataParser implements Parser {
  readonly name = "ArchiveMetadataParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/x-rar-compressed",
        "application/x-rar-compressed;version=4",
        "application/x-rar-compressed;version=5",
        "application/x-7z-compressed",
        "application/x-arj",
      ].map((type) => MediaType.parse(type)!),
    );
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
    const info = describe(data);
    for (const [key, value] of Object.entries(info)) metadata.set(`archive:${key}`, value);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const [key, value] of Object.entries(info)) {
      await xhtml.element("p", `${key}: ${value}`);
    }
    await xhtml.endDocument();
  }
}

function describe(data: Uint8Array): Record<string, string> {
  if (data[0] === 0x37 && data[1] === 0x7a && data[2] === 0xbc && data[3] === 0xaf) {
    if (data.length < 32) throw new MalformedDocumentError("Truncated 7z start header");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      format: "7z",
      version: `${data[6]}.${data[7]}`,
      nextHeaderOffset: String(view.getBigUint64(12, true)),
      nextHeaderSize: String(view.getBigUint64(20, true)),
    };
  }
  if (data[0] === 0x60 && data[1] === 0xea) {
    return { format: "ARJ", version: String(data[6] ?? 0) };
  }
  if (data[0] === 0x52 && data[1] === 0x61 && data[2] === 0x72 && data[3] === 0x21) {
    const version = data[6] === 0x01 ? 5 : 4;
    return { format: `RAR${version}`, version: String(version) };
  }
  throw new MalformedDocumentError("Unknown archive signature");
}
