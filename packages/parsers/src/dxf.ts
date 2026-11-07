import {
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** ASCII DXF text extraction (TEXT/MTEXT and string groups). */
export class DxfParser implements Parser {
  readonly name = "DXFParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([
      MediaType.parse("image/vnd.dxf")!,
      MediaType.parse("image/vnd.dxf;format=ascii")!,
    ]);
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
    const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    const lines = text.split(/\r?\n/);
    const values: string[] = [];
    for (let index = 0; index + 1 < lines.length; index += 2) {
      const code = Number(lines[index]?.trim());
      const value = lines[index + 1]?.trim() ?? "";
      if ([1, 3, 4, 7, 1000, 1001].includes(code) && value.length > 0) {
        values.push(value);
      }
    }

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const value of values) await xhtml.element("p", value);
    await xhtml.endDocument();
  }
}
