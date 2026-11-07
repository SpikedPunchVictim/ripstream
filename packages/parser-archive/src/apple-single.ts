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
import { parseEntry, readAll } from "./util.ts";

const DATA_FORK = 2;

/** AppleSingle/AppleDouble parser; extracts the data fork. */
export class AppleSingleParser implements Parser {
  readonly name = "AppleSingleFileParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/applefile"].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    if (data.byteLength < 26) {
      throw new MalformedDocumentError("Truncated AppleSingle header");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = view.getUint32(0);
    if (magic !== 0x00051600 && magic !== 0x00051607) {
      throw new MalformedDocumentError("Not an AppleSingle file");
    }
    const entries = view.getUint16(24);
    let dataFork: Uint8Array | null = null;
    for (let index = 0; index < entries; index++) {
      const offset = 26 + index * 12;
      if (offset + 12 > data.byteLength) break;
      const id = view.getUint32(offset);
      const start = view.getUint32(offset + 4);
      const length = view.getUint32(offset + 8);
      if (id === DATA_FORK) {
        dataFork = data.subarray(start, Math.min(start + length, data.byteLength));
        break;
      }
    }
    if (dataFork === null) {
      throw new MalformedDocumentError("AppleSingle data fork is missing");
    }

    const name = (metadata.get("resourceName") ?? "data").replace(
      /\.(as|ad)$/i,
      "",
    );
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await parseEntry(xhtml, name, dataFork, metadata, ctx);
    await xhtml.endDocument();
  }
}
