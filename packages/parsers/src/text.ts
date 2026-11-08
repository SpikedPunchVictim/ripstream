import {
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { createDecoder } from "./charset.ts";
import { detectEncoding } from "@spikedpunch/ripstream-mime";

/**
 * Port of TextAndCSVParser's plain-text path. Decoding uses Ripstream's encoding
 * heuristics; text is wrapped in XHTML paragraphs so both text and XHTML
 * handlers receive upstream-shaped events.
 */
export class TextParser implements Parser {
  readonly name = "TextParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "text/plain",
        "application/json",
        "application/manifest+json",
        "application/ld+json",
        "application/geotopic+json",
        "text/x-yaml",
        "application/javascript",
        "application/x-sh",
        "text/javascript",
        "text/css",
        "text/x-java-source",
        "text/x-python",
        "text/x-csrc",
        "text/x-c++src",
        "text/x-csharp",
        "text/x-go",
        "text/x-rust",
        "text/vcard",
        "text/x-vcard",
        "text/calendar",
        "text/x-vcalendar",
        // Lowest-priority fallback: CompositeParser prefers exact registrations
        // (html, csv, markdown, xml, ...) over type/*, so this only catches
        // otherwise-unhandled subtypes such as text/x-log or text/x-sh.
        "text/*",
      ].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const prefix = await stream.peek(64 * 1024);
    const encoding = detectEncoding(prefix);

    const { decoder, charset } = createDecoder(encoding.charset);
    metadata.set("Content-Encoding", charset);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    // Emit each decoded segment immediately inside the open <p> so memory stays
    // O(chunk) even for a newline-free body and the handler's output limit can
    // fire mid-line. Several characters() calls within one <p> are legal SAX.
    let inParagraph = false;
    let heldCarriageReturn = false;
    const emitSegment = async (segment: string): Promise<void> => {
      if (!inParagraph) {
        await xhtml.startElement("p");
        inParagraph = true;
      }
      if (segment.length > 0) await xhtml.characters(segment);
    };
    const endLine = async (): Promise<void> => {
      await xhtml.endElement("p");
      inParagraph = false;
    };
    const feed = async (decoded: string, final: boolean): Promise<void> => {
      let text = heldCarriageReturn ? `\r${decoded}` : decoded;
      heldCarriageReturn = false;
      // A trailing \r may be the first half of \r\n split across chunks.
      if (!final && text.endsWith("\r")) {
        heldCarriageReturn = true;
        text = text.slice(0, -1);
      }
      let position = 0;
      for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        await emitSegment(text.slice(position, match.index));
        await endLine();
        position = match.index + match[0].length;
      }
      await emitSegment(text.slice(position));
      if (final) await endLine();
    };
    for await (const chunk of stream) {
      await feed(decoder.decode(chunk, { stream: true }), false);
    }
    await feed(decoder.decode(), true);
    await xhtml.endDocument();
  }
}
