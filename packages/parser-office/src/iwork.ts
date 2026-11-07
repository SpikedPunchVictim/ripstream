import {
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParserDeclinedError,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip } from "./bounded-unzip.ts";
import { parseXmlTree, type XmlNode } from "./xml-tree.ts";

const TYPES = [
  "application/vnd.apple.keynote",
  "application/vnd.apple.pages",
  "application/vnd.apple.numbers",
  "application/vnd.apple.iwork",
];

/** iWork '09 package parser for index.apxl XML. */
export class IWork09Parser implements Parser {
  readonly name = "IWorkPackageParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(TYPES.map((type) => MediaType.parse(type)!));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
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
    const files = boundedUnzip(data, ctx.limits);
    const indexName = files.has("index.apxl") ? "index.apxl" : "Index.apxl";
    if (!files.has(indexName)) {
      throw new ParserDeclinedError("Not an iWork '09 package");
    }
    const root = parseXmlTree(
      new TextDecoder("utf-8", { fatal: false }).decode(
        files.get(indexName)!,
      ),
    );
    const values: string[] = [];
    collectText(root, values);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const value of values) await xhtml.element("p", value);
    await xhtml.endDocument();
  }
}

function collectText(node: XmlNode, values: string[]): void {
  for (const child of node.children) {
    if (child.children.length === 0) {
      const text = child.text.trim();
      if (text.length > 0) values.push(text);
    } else {
      collectText(child, values);
    }
  }
}
