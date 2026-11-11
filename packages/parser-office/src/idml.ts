import {
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type MaybePromise,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip, type BoundedZip } from "./bounded-unzip.ts";
import { decodeUtf8, readAll } from "./bytes.ts";
import { describeFailure, isFatal } from "./failures.ts";
import { extractBasicXmp } from "./xmp-basic.ts";
import { parseXmlChunked, type XmlEvents } from "./xml-events.ts";

/*
 * Port of Tika 4.2.0's IDMLParser and ContentAndMetadataExtractor (tika-parser-miscoffice-module), for Adobe InDesign
 * IDML packages. Read from those sources; not run against a Tika. The XMP of META-INF/metadata.xml is read by a narrow
 * port of XmpExtractor (xmp-basic.ts).
 */

const IDML_TYPE = "application/vnd.adobe.indesign-idml-package";
const META_NAME = "META-INF/metadata.xml";

interface PageCounts {
  pages: number;
  masterSpreadPages: number;
}

export class IDMLParser implements Parser {
  readonly name = "IDMLParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(IDML_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const files = boundedUnzip(await readAll(stream), ctx.limits);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    // The totals of this parse only: the parser instance is shared by every parse.
    const counts: PageCounts = { pages: 0, masterSpreadPages: 0 };

    // The XMP first, then everything in archive order.
    if (files.has(META_NAME)) await handleEntry(files, META_NAME, xhtml, metadata, counts, ctx);
    for (const name of files.names) {
      if (name !== META_NAME) await handleEntry(files, name, xhtml, metadata, counts, ctx);
    }

    metadata.set("idml:spread-page-count", String(counts.pages));
    metadata.set("idml:master-spread-page-count", String(counts.masterSpreadPages));
    metadata.set("meta:page-count", String(addInts(counts.pages, counts.masterSpreadPages)));
    await xhtml.endDocument();
  }
}

/** IDMLParser.handleZipEntry. The entries are told apart by their names, in this order. */
async function handleEntry(
  files: BoundedZip,
  name: string,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  counts: PageCounts,
  ctx: ParseContext,
): Promise<void> {
  if (name === "mimetype") {
    const bytes = files.get(name);
    if (bytes !== undefined) metadata.set("Content-Type", decodeUtf8(bytes));
  } else if (name === META_NAME) {
    await handleXmp(files, metadata, ctx);
  } else if (name.includes("MasterSpreads")) {
    counts.masterSpreadPages = addInts(counts.masterSpreadPages, await extractPart(files, name, xhtml, true));
  } else if (name.includes("Spreads/Spread")) {
    counts.pages = addInts(counts.pages, await extractPart(files, name, xhtml, true));
  } else if (name.includes("Stories")) {
    await extractPart(files, name, xhtml, false);
  }
}

/** Malformed XMP is recorded as a warning and must not fail the package; a limit still does. */
async function handleXmp(files: BoundedZip, metadata: Metadata, ctx: ParseContext): Promise<void> {
  try {
    const bytes = files.get(META_NAME);
    if (bytes !== undefined) await extractBasicXmp(decodeUtf8(bytes), metadata);
  } catch (error) {
    if (isFatal(error, ctx)) throw error;
    // EmbeddedDocumentUtil.recordException: Tika records the exception with its stack trace.
    metadata.add("tk:exception:warn", describeFailure(error));
  }
}

/**
 * ContentAndMetadataExtractor.extract for one entry: its Content elements as paragraphs.
 *
 * @returns the page count of the entry when `pageCount`: the sum of the PageCount attributes of its Spread and
 *          MasterSpread elements (any element of that local name, namespace or not, so the idPkg:Spread wrapper of a
 *          spread file counts as one too); 0 when it has none
 * @throws MalformedDocumentError when the entry is not well-formed, or when `pageCount` and it has no such element
 *         (where Tika's Integer.parseInt(null) throws NumberFormatException)
 */
async function extractPart(
  files: BoundedZip,
  name: string,
  xhtml: XHTMLContentHandler,
  pageCount: boolean,
): Promise<number> {
  const bytes = files.get(name);
  if (bytes === undefined) return 0;
  const content = new ContentAndMetadataHandler(xhtml);
  const failure = await parseXmlChunked(decodeUtf8(bytes), content, () => content.drain());
  if (failure !== undefined) throw new MalformedDocumentError(`${name} is not well-formed XML: ${failure.message}`);
  if (!pageCount) return 0;
  if (!content.seenSpread) throw new MalformedDocumentError(`${name} has no Spread or MasterSpread element`);
  return content.pageCount;
}

/**
 * ContentAndMetadataExtractor.ContentAndMetadataHandler. saxes calls it synchronously, so what it writes is queued and
 * drained between chunks of the XML.
 */
class ContentAndMetadataHandler implements XmlEvents {
  seenSpread = false;
  pageCount = 0;
  private inContent = false;
  private readonly steps: Array<() => MaybePromise<void>> = [];
  private readonly xhtml: XHTMLContentHandler;

  constructor(xhtml: XHTMLContentHandler) {
    this.xhtml = xhtml;
  }

  async drain(): Promise<void> {
    for (const step of this.steps.splice(0)) await step();
  }

  open(localName: string, attributes: Record<string, string>): void {
    if (localName === "Spread" || localName === "MasterSpread") {
      this.seenSpread = true;
      const value = attributes.PageCount;
      if (value !== undefined) {
        // A PageCount that is not an int adds nothing.
        const count = parseJavaInt(value);
        if (count !== undefined) this.pageCount = addInts(this.pageCount, count);
      }
    }
    if (localName === "Content") {
      this.inContent = true;
      this.steps.push(() => this.xhtml.startElement("p"));
    }
  }

  text(text: string): void {
    if (this.inContent) this.steps.push(() => this.xhtml.characters(text));
  }

  close(localName: string): void {
    if (localName === "Content") {
      this.inContent = false;
      this.steps.push(() => this.xhtml.endElement("p"));
    }
  }
}

/** Java int addition, which wraps. */
function addInts(a: number, b: number): number {
  return (a + b) | 0;
}

/** Integer.parseInt(value.trim()) for ASCII digits: an optional sign and digits that fit an int, else undefined. */
function parseJavaInt(value: string): number | undefined {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  const text = value.slice(start, end);
  if (!/^[+-]?\d{1,12}$/.test(text)) return undefined;
  const number = Number(text);
  return number >= -(2 ** 31) && number <= 2 ** 31 - 1 ? number : undefined;
}
