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

/** FITS header-card metadata parser. */
export class FitsParser implements Parser {
  readonly name = "FITSParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/fits")!]);
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
    const cards = readCards(data);
    if (!cards.has("SIMPLE") && !cards.has("XTENSION")) {
      throw new MalformedDocumentError("Not a FITS file");
    }
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const [key, value] of cards) {
      metadata.set(`fits:${key}`, value);
      await xhtml.element("p", `${key}: ${value}`);
    }
    await xhtml.endDocument();
  }
}

function readCards(data: Uint8Array): Map<string, string> {
  const cards = new Map<string, string>();
  const text = new TextDecoder("ascii").decode(data);
  for (let offset = 0; offset + 80 <= text.length; offset += 80) {
    const card = text.slice(offset, offset + 80);
    if (card.startsWith("END")) break;
    const keyword = card.slice(0, 8).trim();
    if (keyword.length === 0) continue;
    if (card[8] === "=") {
      const value = card
        .slice(9)
        .split("/")[0]
        ?.trim()
        .replace(/^'|'$/g, "")
        .trim();
      if (value !== undefined && value.length > 0) cards.set(keyword, value);
    } else {
      cards.set(keyword, card.slice(8).trim());
    }
  }
  return cards;
}
