import {
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { readAll } from "./bytes.ts";
import { declineUnlessVersion } from "./exact-version.ts";
import { OleFile } from "./ole-stream.ts";

/*
 * Port of Tika 4.2.0's DGN8Parser (tika-parser-cad-module). Tika calls it "a VERY LIMITED parser": a MicroStation v8
 * design file is an OLE2 file, and all it reads is the summary property sets. Read from that source; not run against
 * a Tika (there is no JDK here).
 */

export class Dgn8Parser implements Parser {
  readonly name = "DGN8Parser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow("image/vnd.dgn; version=8")]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    // Tika's MIME database also spells the parameter `ver=8`.
    declineUnlessVersion(metadata, "image/vnd.dgn", ["version", "ver"], ["8"]);
    const file = OleFile.open(await readAll(stream));
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    file.applySummaries(metadata);
    await xhtml.endDocument();
  }
}
