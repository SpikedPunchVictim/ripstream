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
    _ctx: ParseContext,
  ): Promise<void> {
    const prefix = await stream.peek(64 * 1024);

    const pending: string[] = [];
    const stack: Array<{ localName: string; namespaceURI: string; text: string }> = [];
    let failed: Error | null = null;

    const parser = new SaxesParser({ xmlns: true });
    const addText = (text: string): void => {
      const current = stack.at(-1);
      if (current !== undefined) current.text += text;
      pending.push(text);
    };
    parser.on("opentag", (tag) => {
      const nsTag = tag as unknown as { local: string; uri: string };
      stack.push({ localName: nsTag.local, namespaceURI: nsTag.uri, text: "" });
      pending.push(" ");
    });
    parser.on("text", addText);
    parser.on("cdata", addText);
    parser.on("closetag", () => {
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
    const { decoder } = createDecoder(detectXmlEncoding(prefix));
    try {
      for await (const chunk of stream) {
        parser.write(decoder.decode(chunk, { stream: true }));
        await drain(pending, xhtml);
      }
      parser.write(decoder.decode());
      parser.close();
      await drain(pending, xhtml);
    } catch (error) {
      if (error instanceof RipstreamError) throw error;
      throw new MalformedDocumentError("Malformed XML", { cause: error });
    }

    if (failed !== null) throw new MalformedDocumentError("Malformed XML", { cause: failed });
    await xhtml.endElement("p");
    await xhtml.endDocument();
  }
}

async function drain(pending: string[], handler: XHTMLContentHandler): Promise<void> {
  for (const text of pending.splice(0)) await handler.characters(text);
}
