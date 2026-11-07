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

/** IPTC ANPA 1312 wire-format text extraction. */
export class AnpaParser implements Parser {
  readonly name = "AnpaParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("text/vnd.iptc.anpa")!]);
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
    const records: string[] = [];
    let position = 0;
    while (position + 4 <= data.length) {
      const length = (data[position]! << 16) | (data[position + 1]! << 8) | data[position + 2]!;
      position += 4;
      if (length <= 0 || position + length > data.length) {
        throw new MalformedDocumentError("Invalid ANPA record length");
      }
      const text = new TextDecoder("windows-1252")
        .decode(data.subarray(position, position + length))
        .trim();
      position += length;
      if (text.length > 0) records.push(text);
    }
    if (records.length === 0) throw new MalformedDocumentError("No ANPA records");
    metadata.set("anpa:record-count", String(records.length));
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const record of records) await xhtml.element("p", record);
    await xhtml.endDocument();
  }
}
