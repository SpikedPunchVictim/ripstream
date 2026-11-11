import {
  AttributesImpl,
  ContentHandlerDecorator,
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type MaybePromise,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip, parseXmlChunked, type XmlEvents } from "@spikedpunch/ripstream-parser-office";
import { readAll } from "./bytes.ts";
import { createDecoder } from "./charset.ts";
import { detectXmlEncoding } from "./xml-encoding.ts";

/*
 * Port of Tika 4.2.0's XLZParser, XLIFF12Parser and XLIFF12ContentHandler (tika-parser-xml-module): an XLZ archive is
 * a ZIP of XLIFF 1.2 files. Read from those sources; not run against a Tika.
 */

const XLZ_TYPE = "application/x-xliff+zip";
const XLF_TYPE = "application/x-xliff+xml";
/** XLZParser reads every entry whose name contains this. */
const XLF = ".xlf";

export class XLZParser implements Parser {
  readonly name = "XLZParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(XLZ_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const files = boundedUnzip(await readAll(stream), ctx.limits);
    // Each XLIFF file is parsed as a document of its own, whose end the shield keeps from ending this one.
    const xhtml = new XHTMLContentHandler(handler, metadata);
    const shield = new EndDocumentShield(xhtml);
    for (const name of files.names) {
      if (!name.includes(XLF)) continue;
      const bytes = files.get(name);
      if (bytes !== undefined) await parseXliff12(bytes, shield, metadata);
    }
    // A parse that failed does not get here: Tika does not end the document either.
    if (shield.endDocumentWasCalled) await xhtml.endDocument();
  }
}

/** EndDocumentShieldingContentHandler: passes everything on but the end of the document, which it only notes. */
class EndDocumentShield extends ContentHandlerDecorator {
  endDocumentWasCalled = false;

  override endDocument(): MaybePromise<void> {
    this.endDocumentWasCalled = true;
  }
}

/** XLIFF12Parser.parse. */
async function parseXliff12(bytes: Uint8Array, shield: ContentHandler, metadata: Metadata): Promise<void> {
  metadata.set("Content-Type", XLF_TYPE);
  const xhtml = new XHTMLContentHandler(shield, metadata);
  await xhtml.startDocument();
  try {
    const { decoder } = createDecoder(detectXmlEncoding(bytes));
    const content = new Xliff12ContentHandler(xhtml, metadata);
    const failure = await parseXmlChunked(decoder.decode(bytes), content, () => content.drain());
    if (failure !== undefined) throw new MalformedDocumentError(`Malformed XLIFF: ${failure.message}`);
    content.endDocument();
  } finally {
    await xhtml.endDocument();
  }
}

/**
 * XLIFF12ContentHandler. saxes calls it synchronously, so what it writes is queued, in the order Tika's handler does
 * it, and drained between chunks of the XML.
 */
class Xliff12ContentHandler implements XmlEvents {
  private numberOfFiles = 0;
  private numberOfTUs = 0;
  private inTransUnit = false;
  private readonly steps: Array<() => MaybePromise<void>> = [];
  private readonly xhtml: XHTMLContentHandler;
  private readonly metadata: Metadata;

  constructor(xhtml: XHTMLContentHandler, metadata: Metadata) {
    this.xhtml = xhtml;
    this.metadata = metadata;
  }

  async drain(): Promise<void> {
    for (const step of this.steps.splice(0)) await step();
  }

  open(localName: string, attributes: Record<string, string>): void {
    if (localName === "file") {
      this.numberOfFiles++;
      const sourceLanguage = attributes["source-language"];
      const targetLanguage = attributes["target-language"];
      // Tika adds the source language under "original" (sic), and the file's original name only as the heading.
      this.addMetadata("original", sourceLanguage);
      this.steps.push(() => this.xhtml.startElement("div"));
      this.steps.push(() => this.xhtml.startElement("h1"));
      this.steps.push(() => this.xhtml.characters(attributes.original ?? ""));
      this.steps.push(() => this.xhtml.endElement("h1"));
      this.addMetadata("source-language", sourceLanguage);
      this.addMetadata("target-language", targetLanguage);
    }
    if (localName === "trans-unit") {
      this.numberOfTUs++;
      this.inTransUnit = true;
      this.steps.push(() => this.xhtml.startElement("", "div", "div", copiedAttributes(attributes)));
    }
    if (localName === "source" || localName === "target") {
      this.steps.push(() => this.xhtml.startElement("", "p", "p", langAttribute(attributes)));
    }
  }

  text(text: string): void {
    if (this.inTransUnit && text.length > 0) this.steps.push(() => this.xhtml.characters(text));
  }

  close(localName: string): void {
    if (localName === "file") this.steps.push(() => this.xhtml.endElement("div"));
    if (localName === "trans-unit") {
      this.inTransUnit = false;
      this.steps.push(() => this.xhtml.endElement("div"));
    }
    if (localName === "source" || localName === "target") this.steps.push(() => this.xhtml.endElement("p"));
  }

  /** The end of the SAX document, which a document that is not well-formed never reaches. */
  endDocument(): void {
    this.metadata.set("file-count", String(this.numberOfFiles));
    this.metadata.set("tu-count", String(this.numberOfTUs));
  }

  /** Metadata.add of a value that may be missing, which adds nothing. */
  private addMetadata(key: string, value: string | undefined): void {
    if (value === undefined) return;
    this.steps.push(() => {
      this.metadata.add(key, value);
    });
  }
}

/** The attributes of the element as they were written, without the namespace declarations a SAX parser does not report. */
function copiedAttributes(attributes: Record<string, string>): AttributesImpl {
  const copy = new AttributesImpl();
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    const colon = name.indexOf(":");
    copy.addAttribute("", colon < 0 ? name : name.slice(colon + 1), name, "CDATA", value);
  }
  return copy;
}

/** XLIFF12ContentHandler.extractAttributes: xml:lang as lang, and nothing else. */
function langAttribute(attributes: Record<string, string>): AttributesImpl {
  const copy = new AttributesImpl();
  const language = attributes["xml:lang"];
  if (language !== undefined) copy.addAttribute("", "lang", "lang", "", language);
  return copy;
}
