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

    // Emit lines as they are decoded so memory stays O(chunk + longest line)
    // and the handler's output limit can stop the read early.
    const emitLine = async (line: string): Promise<void> => {
      await xhtml.startElement("p");
      if (line.length > 0) await xhtml.characters(line);
      await xhtml.endElement("p");
    };
    let pending = "";
    let heldCarriageReturn = false;
    const feed = async (decoded: string, final: boolean): Promise<void> => {
      let text = heldCarriageReturn ? `\r${decoded}` : decoded;
      heldCarriageReturn = false;
      // A trailing \r may be the first half of \r\n split across chunks.
      if (!final && text.endsWith("\r")) {
        heldCarriageReturn = true;
        text = text.slice(0, -1);
      }
      if (/[\r\n]/.test(text)) {
        const lines = text.split(/\r\n|\r|\n/);
        lines[0] = pending + lines[0]!;
        pending = lines.pop()!;
        for (const line of lines) await emitLine(line);
      } else {
        pending += text;
      }
      if (final) await emitLine(pending);
    };
    for await (const chunk of stream) {
      await feed(decoder.decode(chunk, { stream: true }), false);
    }
    await feed(decoder.decode(), true);
    await xhtml.endDocument();
  }
}
