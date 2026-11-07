import {
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** Outlook PST/OST header metadata (store contents not decoded). */
export class PstParser implements Parser {
  readonly name = "OutlookPSTParser";
  readonly capabilities = { requiresRandomAccess: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/vnd.ms-outlook-pst")!]);
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
    if (data.length < 512 || String.fromCharCode(...data.subarray(0, 4)) !== "!BDN") {
      throw new MalformedDocumentError("Not an Outlook PST/OST file");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = view.getUint16(8, true);
    const clientVersion = view.getUint16(10, true);
    metadata.set("pst:version", String(version));
    metadata.set("pst:client-version", String(clientVersion));
    metadata.set("pst:ost", version >= 23 ? "true" : "false");
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.element("p", `PST version: ${version}`);
    await xhtml.endDocument();
  }
}
