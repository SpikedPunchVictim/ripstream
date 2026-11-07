import { createDecoder } from "./charset.ts";
import {
  MediaType,
  Metadata,
  MalformedDocumentError,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { decodeText } from "@spikedpunch/ripstream-mime";
import { SaxesParser } from "saxes";
import { detectXmlEncoding } from "./xml-encoding.ts";

const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";

type Event =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "element"; readonly name: string };

/**
 * Port of the generic XMLParser/DcXMLParser behavior: stream the document to
 * text, capture Dublin Core elements as metadata, and reject DTDs.
 * ParseLimits.maxXmlEntityExpansions is intentionally not consulted: saxes
 * expands only the five predefined entities and character references, so
 * there is no entity amplification to bound.
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
    if (/<!DOCTYPE/i.test(decodeText(prefix, "UTF-8"))) {
      throw new MalformedDocumentError("DTD processing is disabled");
    }

    const events: Event[] = [];
    const stack: Array<{ localName: string; namespaceURI: string; text: string }> = [];
    let failed: Error | null = null;

    const parser = new SaxesParser({ xmlns: true });
    parser.on("opentag", (tag) => {
      const nsTag = tag as unknown as { local: string; uri: string };
      stack.push({ localName: nsTag.local, namespaceURI: nsTag.uri, text: "" });
      events.push({ type: "element", name: "p" });
    });
    parser.on("text", (text) => {
      const current = stack.at(-1);
      if (current !== undefined) current.text += text;
      events.push({ type: "text", text });
    });
    parser.on("closetag", () => {
      const current = stack.pop();
      if (
        current !== undefined &&
        current.namespaceURI === DC_NAMESPACE &&
        current.text.trim().length > 0
      ) {
        metadata.set(`dc:${current.localName}`, current.text.trim());
      }
      events.push({ type: "element", name: "p" });
    });
    parser.on("error", (error) => {
      failed = error;
    });

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    const { decoder, charset } = createDecoder(detectXmlEncoding(prefix));
    metadata.set("Content-Encoding", charset);
    try {
      for await (const chunk of stream) {
        parser.write(decoder.decode(chunk, { stream: true }));
        await drain(events, xhtml);
      }
      parser.write(decoder.decode());
      parser.close();
      await drain(events, xhtml);
    } catch (error) {
      throw new MalformedDocumentError("Malformed XML", { cause: error });
    }

    if (failed !== null) throw new MalformedDocumentError("Malformed XML", { cause: failed });
    await xhtml.endDocument();
  }
}

async function drain(events: Event[], handler: XHTMLContentHandler): Promise<void> {
  while (events.length > 0) {
    const event = events.shift()!;
    if (event.type === "text") await handler.characters(event.text);
    else if (event.name === "p") {
      // Element boundaries are intentionally flattened; text output stays raw.
    }
  }
}
