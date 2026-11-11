import {
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { createDecoder, recordDetectedEncoding, withCharset } from "./charset.ts";
import { detectEncoding } from "@spikedpunch/ripstream-mime";

/** The types Tika's SourceCodeParser takes; it records `Content-Encoding` and leaves `Content-Type` bare. */
const SOURCE_CODE_TYPES: ReadonlySet<string> = new Set(["text/x-java-source", "text/x-c++src"]);

/**
 * Port of TextAndCSVParser's plain-text path, for the text types it does not sniff (JSON, source code, `text/*`, ...):
 * `text/plain` and `text/csv` go to {@link CsvParser}, which decides between a table and text. Decoding uses Ripstream's encoding
 * heuristics; text is wrapped in XHTML paragraphs so both text and XHTML
 * handlers receive upstream-shaped events.
 */
export class TextParser implements Parser {
  readonly name = "TextParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/json",
        "application/manifest+json",
        "application/ld+json",
        "application/geotopic+json",
        // Not sniffed: a type other than text/plain, text/csv and text/tsv is text to Tika's TextAndCSVParser.
        "text/tab-separated-values",
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
    recordDetectedEncoding(metadata, charset);
    // Tika's TXTParser writes `<incoming type>; charset=<detected>`; its SourceCodeParser leaves the type bare.
    const incoming = metadata.get("Content-Type");
    if (!SOURCE_CODE_TYPES.has(MediaType.parse(incoming)?.getBaseType().toString() ?? "")) {
      metadata.set("Content-Type", withCharset(incoming, "text/plain", charset));
    }

    await writeText(stream, handler, metadata, decoder);
  }
}

/**
 * Writes the rest of `stream`, decoded with `decoder`, as XHTML paragraphs, one per line. Memory stays O(chunk): each
 * decoded segment is emitted at once.
 */
export async function writeText(
  stream: RipstreamInputStream,
  handler: ContentHandler,
  metadata: Metadata,
  decoder: TextDecoder,
): Promise<void> {
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
