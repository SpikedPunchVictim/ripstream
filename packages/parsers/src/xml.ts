import { createDecoder } from "./charset.ts";
import {
  MediaType,
  Metadata,
  MalformedDocumentError,
  RipstreamError,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { XmlNamespaceScope } from "@spikedpunch/ripstream-mime";
import { SaxesParser } from "saxes";
import { detectXmlEncoding } from "./xml-encoding.ts";

const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";

/**
 * Port of the generic XMLParser/DcXMLParser behavior: stream the document to
 * text, capture Dublin Core elements as metadata.
 *
 * Like Tika's XMLParser the text is one XHTML paragraph, with a space written
 * at every element start (its TextContentHandler is built with
 * addSpaceBetweenElements = true) so adjacent elements do not run together.
 *
 * A DOCTYPE is accepted, as Tika's XMLReaderUtils accepts it, but its DTD is
 * never read: saxes skips the declaration and its internal subset without
 * interpreting them, never loads an external DTD or entity, and expands only
 * the five predefined entities and character references. So a reference to
 * an entity the DTD declares is a malformed document here (Tika expands the
 * internal ones within the JAXP limits), and there is no entity
 * amplification to bound: ParseLimits.maxXmlEntityExpansions is
 * intentionally not consulted.
 */
export class XmlParser implements Parser {
  readonly name = "XMLParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([
      MediaType.APPLICATION_XML,
      MediaType.parse("text/xml")!,
      MediaType.parse("image/svg+xml")!,
      MediaType.parse("application/rdf+xml")!,
      MediaType.parse("application/vnd.iso.19139+xml")!,
      MediaType.parse("application/vnd.iso.19115+xml")!,
      MediaType.parse("application/vnd.ms-wordml")!,
      MediaType.parse("application/vnd.ms-word2006ml")!,
      MediaType.parse("application/vnd.ms-spreadsheetml")!,
      MediaType.parse("application/x-fictionbook+xml")!,
      MediaType.parse("application/vnd.oasis.opendocument.tika.flat.document")!,
      MediaType.parse("application/vnd.oasis.opendocument.flat.text")!,
      MediaType.parse("application/vnd.oasis.opendocument.flat.spreadsheet")!,
      MediaType.parse("application/vnd.oasis.opendocument.flat.presentation")!,
    ]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const prefix = await stream.peek(64 * 1024);
    const { decoder, charset } = createDecoder(detectXmlEncoding(prefix));
    // Tika's Xerces reads a UTF-16/32 document a buffer at a time and fails on a stray last byte before it reports any
    // SAX event, so the body is empty (tikajs-bhvl). A parser error of any other kind keeps what was read (Tika does).
    // The text of such a document is held until its length is known: one whose bytes do not come in whole units keeps
    // none of it. Past the output limit the hold is given up rather than growing without bound.
    const unit = /^utf-16/i.test(charset) ? 2 : /^utf-32/i.test(charset) ? 4 : 0;
    let hold = unit !== 0;
    let totalBytes = 0;
    let heldChars = 0;

    const pending: string[] = [];
    const stack: Array<{ localName: string; namespaceURI: string; text: string }> = [];
    let failed: Error | null = null;

    // Namespaces are resolved by XmlNamespaceScope: saxes with xmlns:true is quadratic in nesting depth.
    const scope = new XmlNamespaceScope();
    const parser = new SaxesParser({ xmlns: false });
    const addText = (text: string): void => {
      const current = stack.at(-1);
      // The white space of the prolog and of what follows the root is not text: Tika's XML handler never sees it.
      if (current === undefined) return;
      current.text += text;
      pending.push(text);
    };
    parser.on("opentag", (tag) => {
      const element = scope.open(tag.name, tag.attributes);
      stack.push({ localName: element.local, namespaceURI: element.uri, text: "" });
      pending.push(" ");
    });
    parser.on("text", addText);
    parser.on("cdata", addText);
    parser.on("closetag", () => {
      scope.close();
      const current = stack.pop();
      if (
        current !== undefined &&
        current.namespaceURI === DC_NAMESPACE &&
        current.text.trim().length > 0
      ) {
        metadata.set(`dc:${current.localName}`, current.text.trim());
      }
    });
    parser.on("error", (error) => {
      failed = error;
    });

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.startElement("p");

    // Tika's XMLParser writes no Content-Encoding and no charset in Content-Type.
    try {
      for await (const chunk of stream) {
        totalBytes += chunk.byteLength;
        // The failure's kind is not known until the bytes are counted; the rest of the input is only read.
        if (failed !== null) continue;
        parser.write(decoder.decode(chunk, { stream: true }));
        if (hold) {
          for (const text of pending) heldChars += text.length;
          if (heldChars > ctx.limits.maxOutputChars) {
            await drain(pending, xhtml);
            hold = false;
          }
        } else {
          await drain(pending, xhtml);
        }
      }
      if (failed === null) {
        parser.write(decoder.decode());
        parser.close();
      }
    } catch (error) {
      if (error instanceof RipstreamError) throw error;
      throw new MalformedDocumentError("Malformed XML", { cause: error });
    }

    if (failed !== null) {
      // A document of whole units keeps its text; one with a stray last byte writes none, as Tika's parser fails before it
      // reports an event. A hold given up at the output limit has written part already.
      if (!hold || unit === 0 || totalBytes % unit === 0) {
        await drain(pending, xhtml);
        await xhtml.endElement("p");
      }
      throw new MalformedDocumentError("Malformed XML", { cause: failed });
    }
    await drain(pending, xhtml);
    await xhtml.endElement("p");
    await xhtml.endDocument();
  }
}

async function drain(pending: string[], handler: XHTMLContentHandler): Promise<void> {
  for (const text of pending.splice(0)) await handler.characters(text);
}
