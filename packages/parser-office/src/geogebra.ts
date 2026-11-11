import {
  CONTEXT_KEYS,
  MediaType,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  TIKA_KEYS,
  XHTMLContentHandler,
  type ContentHandler,
  type Detector,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip, type BoundedZip } from "./bounded-unzip.ts";
import { decodeUtf8, readAll } from "./bytes.ts";
import { describeFailure, isFatal } from "./failures.ts";
import { parseXmlChunked, type XmlEvents } from "./xml-events.ts";

/*
 * Port of Tika 4.2.0's GeoGebraParser, GeoGebraXMLHandler and GeoGebraJson (tika-parser-miscoffice-module), for the
 * three ZIP-based GeoGebra formats: worksheets (.ggb), Notes/Slides (.ggs) and tools (.ggt). Read from those sources;
 * not run against a Tika.
 */

const GEOGEBRA_XML = "geogebra.xml";
const MACRO_XML = "geogebra_macro.xml";
const STRUCTURE_JSON = "structure.json";
const THUMBNAIL_PNG = "geogebra_thumbnail.png";
const JAVASCRIPT_JS = "geogebra_javascript.js";
const HOUSEKEEPING_NAMES = new Set([
  GEOGEBRA_XML,
  MACRO_XML,
  THUMBNAIL_PNG,
  "geogebra_defaults2d.xml",
  "geogebra_defaults3d.xml",
]);
const SLIDE_DIR_PREFIX = "_slide";
const SLIDE_XML_PATTERN = /^(_slide\d+)\/geogebra\.xml$/;

/** structure.json only lists chapters, pages and element ids; a real one is a few kilobytes (GeoGebraParser.java). */
const MAX_STRUCTURE_JSON_LENGTH = 1024 * 1024;
/** Longest `content` JSON that is read (GeoGebraXMLHandler.java). */
const MAX_CONTENT_LENGTH = 1024 * 1024;
/** Jackson's default StreamReadConstraints nesting limit: deeper JSON is an IOException there, so no text here. */
const MAX_JSON_DEPTH = 1000;
/** A GeoGebra string literal: plain double quotes, no escaping (GeoGebraXMLHandler.java). */
const STRING_LITERAL = /"([^"]*)"/g;

type EmbeddedType = "INLINE" | "ATTACHMENT" | "MACRO" | "THUMBNAIL";
type Step = () => void | Promise<void>;

export class GeoGebraParser implements Parser {
  readonly name = "GeoGebraParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/vnd.geogebra.file", "application/vnd.geogebra.slides", "application/vnd.geogebra.tool"].map(
        (type) => MediaType.parseOrThrow(type),
      ),
    );
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

    const slideIds = readSlideIds(files, ctx);
    // Document metadata comes from the first XML parsed: a worksheet's geogebra.xml, a tool's geogebra_macro.xml,
    // or the first slide.
    let documentMetadataPending = true;
    let iconFiles: string[] = [];
    if (files.has(GEOGEBRA_XML)) {
      documentMetadataPending = false;
      await parseGeoGebraXml(files, GEOGEBRA_XML, xhtml, metadata, true, ctx);
    }
    if (files.has(MACRO_XML)) {
      // A worksheet with macros carries both XMLs; the macro one only contributes the tool names then.
      iconFiles = await parseGeoGebraXml(files, MACRO_XML, xhtml, metadata, documentMetadataPending, ctx);
      documentMetadataPending = false;
    }
    const pageNumbers = new Map<string, number>();
    if (slideIds.length > 0) {
      metadata.set("xmpTPg:NPages", String(slideIds.length));
      let page = 1;
      for (const slideId of slideIds) {
        pageNumbers.set(slideId, page++);
        await xhtml.startElement("div", "class", "slide");
        try {
          await parseGeoGebraXml(files, `${slideId}/${GEOGEBRA_XML}`, xhtml, metadata, documentMetadataPending, ctx);
          documentMetadataPending = false;
        } finally {
          await xhtml.endElement("div");
        }
      }
    }
    const thumbnail = await handleThumbnail(files, slideIds, iconFiles, xhtml, metadata, ctx);
    await handleOtherEntries(files, pageNumbers, thumbnail, xhtml, metadata, ctx);
    await xhtml.endDocument();
  }
}

/**
 * The slide directories of a Notes/Slides file in order, or none. The slides are the _slideN/geogebra.xml entries;
 * structure.json only supplies their order, and the slides it does not list (all of them if it is missing, over a
 * mebibyte, or not readable JSON) follow in numeric order.
 */
function readSlideIds(files: BoundedZip, ctx: ParseContext): string[] {
  const numerically: string[] = [];
  for (const name of files.names) {
    const match = SLIDE_XML_PATTERN.exec(name);
    if (match !== null) numerically.push(match[1]!);
  }
  if (numerically.length === 0) return [];
  numerically.sort(compareSlideIds);

  const ordered = new Set<string>();
  if (files.has(STRUCTURE_JSON)) {
    const known = new Set(numerically);
    const text = readText(files, STRUCTURE_JSON, ctx);
    if (text !== undefined && text.length <= MAX_STRUCTURE_JSON_LENGTH) {
      try {
        for (const id of structureElementIds(text)) if (known.has(id)) ordered.add(id);
      } catch {
        // Not JSON: the numeric order.
      }
    }
  }
  for (const id of numerically) ordered.add(id);
  return [...ordered];
}

/** An entry as text, or undefined when it cannot be read (the numeric order then); a limit is not swallowed. */
function readText(files: BoundedZip, name: string, ctx: ParseContext): string | undefined {
  try {
    const bytes = files.get(name);
    return bytes === undefined ? undefined : decodeUtf8(bytes);
  } catch (error) {
    if (isFatal(error, ctx)) throw error;
    return undefined;
  }
}

/**
 * Compares the digit suffixes of two slide ids numerically without parsing them (a crafted id may carry more digits
 * than a long holds): leading zeros aside, a shorter digit string is the smaller number and equal lengths compare
 * lexicographically.
 */
function compareSlideIds(a: string, b: string): number {
  const da = stripLeadingZeros(a.slice(SLIDE_DIR_PREFIX.length));
  const db = stripLeadingZeros(b.slice(SLIDE_DIR_PREFIX.length));
  if (da.length !== db.length) return da.length < db.length ? -1 : 1;
  if (da !== db) return da < db ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function stripLeadingZeros(digits: string): string {
  let i = 0;
  while (i < digits.length - 1 && digits[i] === "0") i++;
  return digits.slice(i);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function members(owner: unknown, field: string): unknown[] {
  if (!isObject(owner) || !Object.hasOwn(owner, field)) return [];
  const value = owner[field];
  return Array.isArray(value) ? value : [];
}

/**
 * The ids of the elements of a structure.json in document order: {"chapters":[{"pages":[{"elements":[{"id":...}]}]}]}
 * (GeoGebraJson.elementIds). Throws on JSON that does not parse.
 */
function structureElementIds(json: string): string[] {
  const ids: string[] = [];
  for (const chapter of members(JSON.parse(json), "chapters")) {
    for (const page of members(chapter, "pages")) {
      for (const element of members(page, "elements")) {
        if (isObject(element) && typeof element.id === "string") ids.push(element.id);
      }
    }
  }
  return ids;
}

/**
 * The values of every `text` field at any depth in document order (GeoGebraJson.textValues): the text runs of a
 * content value such as [{"text":"Hello\n"}]. A text field whose value is null, an object or an array contributes
 * nothing and is not descended into. Throws on JSON that does not parse or nests deeper than Jackson allows.
 */
function textValues(json: string): string[] {
  const texts: string[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value: JSON.parse(json), depth: 1 }];
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (typeof value !== "object" || value === null) continue;
    if (depth > MAX_JSON_DEPTH) throw new Error("JSON nesting is too deep");
    const children: unknown[] = [];
    if (Array.isArray(value)) {
      children.push(...value);
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (key === "text") {
          if (typeof child !== "object" && child !== null) texts.push(String(child));
          // A null, an object or an array is skipped, children and all.
        } else {
          children.push(child);
        }
      }
    }
    // The stack pops last-in first, so push in reverse to keep document order.
    for (let i = children.length - 1; i >= 0; i--) pending.push({ value: children[i], depth: depth + 1 });
  }
  return texts;
}

/**
 * Parses one GeoGebra XML for its text and, if `documentMetadata`, the document metadata. A part that cannot be read
 * or is not well-formed is recorded in the metadata and skipped.
 *
 * @returns the icon files of the macros in the XML, in document order
 */
async function parseGeoGebraXml(
  files: BoundedZip,
  name: string,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  documentMetadata: boolean,
  ctx: ParseContext,
): Promise<string[]> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = files.get(name);
  } catch (error) {
    if (isFatal(error, ctx)) throw error;
    recordStreamException(metadata, error);
    return [];
  }
  if (bytes === undefined) return [];

  const xml = new GeoGebraXmlHandler(xhtml, metadata, documentMetadata);
  const failure = await parseXmlChunked(decodeUtf8(bytes), xml, () => xml.drain());
  if (failure !== undefined) recordStreamException(metadata, failure);
  return xml.iconFiles;
}

/**
 * SAX handler for geogebra.xml and geogebra_macro.xml (GeoGebraXMLHandler.java). saxes calls it synchronously, so what
 * it would write is queued as steps, in the order Tika's handler does it, and drained between chunks of the XML.
 */
class GeoGebraXmlHandler implements XmlEvents {
  readonly iconFiles: string[] = [];
  private readonly steps: Step[] = [];
  private depth = 0;

  private readonly xhtml: XHTMLContentHandler;
  private readonly metadata: Metadata;
  private readonly documentMetadata: boolean;

  constructor(xhtml: XHTMLContentHandler, metadata: Metadata, documentMetadata: boolean) {
    this.xhtml = xhtml;
    this.metadata = metadata;
    this.documentMetadata = documentMetadata;
  }

  async drain(): Promise<void> {
    for (const step of this.steps.splice(0)) await step();
  }

  open(localName: string, attributes: Record<string, string>): void {
    if (this.depth === 0 && localName === "geogebra") {
      if (this.documentMetadata) {
        this.setIfNotBlank("geogebra:app-name", attributes.app);
        this.setIfNotBlank("geogebra:app-version", attributes.version);
        this.setIfNotBlank("geogebra:format-version", attributes.format);
        this.setIfNotBlank("geogebra:id", attributes.id);
      }
    } else if (this.depth === 1 && localName === "construction") {
      // Only the document's own construction; a macro's is one level deeper, inside its <macro>.
      if (this.documentMetadata) {
        this.setIfNotBlank("dc:title", attributes.title);
        this.setIfNotBlank("dc:creator", attributes.author);
        this.setIfNotBlank("geogebra:date", attributes.date);
      }
    } else if (localName === "expression") {
      this.expression(attributes.exp);
    } else if (localName === "content") {
      this.content(attributes.val);
    } else if (localName === "caption") {
      this.paragraph(attributes.val);
    } else if (localName === "macro") {
      let toolName = attributes.toolName;
      if (isBlank(toolName)) toolName = attributes.cmdName;
      if (!isBlank(toolName)) {
        const name = toolName!.trim();
        this.steps.push(() => {
          this.metadata.add("geogebra:toolName", name);
        });
      }
      this.paragraph(toolName);
      this.paragraph(attributes.toolHelp);
      const iconFile = attributes.iconFile;
      if (!isBlank(iconFile)) this.iconFiles.push(iconFile!.trim());
    }
    this.depth++;
  }

  text(): void {}

  close(): void {
    this.depth--;
  }

  /**
   * The string literals of an expression. A text object's expression is a single literal like "some text" or, for a
   * dynamic text, literals combined with values like "Area = " + a; the literals are the user's text and everything
   * else is geometry.
   */
  private expression(exp: string | undefined): void {
    if (exp === undefined || !exp.includes('"')) return;
    let text = "";
    for (const match of exp.matchAll(STRING_LITERAL)) text += match[1]!;
    this.paragraph(text);
  }

  /** The text runs of a rich-text content value, a JSON array of runs: one paragraph per line. */
  private content(value: string | undefined): void {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_CONTENT_LENGTH || (trimmed[0] !== "[" && trimmed[0] !== "{")) {
      // Not a JSON document; a plain string carries no text runs.
      return;
    }
    let text: string;
    try {
      text = textValues(trimmed).join("");
    } catch {
      return;
    }
    for (const line of text.split(/\r\n|[\r\n]/)) this.paragraph(line);
  }

  private paragraph(text: string | undefined): void {
    if (isBlank(text)) return;
    const trimmed = text!.trim();
    this.steps.push(() => this.xhtml.element("p", trimmed));
  }

  private setIfNotBlank(key: string, value: string | undefined): void {
    if (isBlank(value)) return;
    const trimmed = value!.trim();
    this.steps.push(() => {
      this.metadata.set(key, trimmed);
    });
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Emits the representative thumbnail: the root one of a worksheet, the first slide thumbnail (in slide order) of a
 * Notes/Slides file, or the icon of the first tool that has one. A tool file has no rendering of its own; its icon (a
 * picture in a directory with a generated name, named by the macro's iconFile) is what GeoGebra shows for it.
 *
 * @returns the name of the entry emitted, or undefined if there is none
 */
async function handleThumbnail(
  files: BoundedZip,
  slideIds: readonly string[],
  iconFiles: readonly string[],
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<string | undefined> {
  let entry = files.has(THUMBNAIL_PNG) ? THUMBNAIL_PNG : undefined;
  for (let i = 0; entry === undefined && i < slideIds.length; i++) {
    const candidate = `${slideIds[i]}/${THUMBNAIL_PNG}`;
    if (files.has(candidate)) entry = candidate;
  }
  for (let i = 0; entry === undefined && i < iconFiles.length; i++) {
    if (files.has(iconFiles[i]!)) entry = iconFiles[i];
  }
  if (entry === undefined) return undefined;
  await emitEmbedded(files, entry, "THUMBNAIL", undefined, xhtml, metadata, ctx);
  return entry;
}

/**
 * Emits everything that is not GeoGebra housekeeping: the document script as a macro, and inserted pictures and other
 * files as embedded documents. Housekeeping is matched at the root and in the slide directories only, so a file of the
 * same name elsewhere is still emitted.
 */
async function handleOtherEntries(
  files: BoundedZip,
  pageNumbers: ReadonlyMap<string, number>,
  thumbnail: string | undefined,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  for (const name of files.names) {
    // Already emitted as the thumbnail (a tool icon).
    if (name === thumbnail) continue;
    let dir = "";
    let basename = name;
    const slash = name.indexOf("/");
    if (slash >= 0) {
      dir = name.slice(0, slash);
      basename = name.slice(slash + 1);
    }
    const knownDir = dir.length === 0 || pageNumbers.has(dir);
    if (knownDir && (HOUSEKEEPING_NAMES.has(basename) || (dir.length === 0 && basename === STRUCTURE_JSON))) continue;
    const type = knownDir && basename === JAVASCRIPT_JS ? "MACRO" : undefined;
    await emitEmbedded(files, name, type, pageNumbers.get(dir), xhtml, metadata, ctx);
  }
}

/**
 * Emits one zip entry as an embedded document. Without a given type, pictures are INLINE and other files ATTACHMENT,
 * by what the detector makes of them. An entry in a slide directory is tagged with the slide's page number.
 */
async function emitEmbedded(
  files: BoundedZip,
  name: string,
  type: EmbeddedType | undefined,
  page: number | undefined,
  xhtml: XHTMLContentHandler,
  parentMetadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = files.get(name);
  } catch (error) {
    if (isFatal(error, ctx)) throw error;
    recordStreamException(parentMetadata, error);
    return;
  }
  if (bytes === undefined) return;

  const embedded = new Metadata();
  embedded.set(TIKA_KEYS.RESOURCE_NAME, name);
  embedded.set("tk:internal-path", name);
  if (page !== undefined) {
    // PageAnchoring.applyPageMetadata for one page: the sequence property and the single-valued one.
    embedded.set("tk:page:numbers", String(page));
    embedded.set("tk:page:number", String(page));
  }
  let resolved = type;
  if (resolved === undefined) {
    const detected = await detect(bytes, embedded, ctx);
    if (detected !== undefined) embedded.set("Content-Type", detected.toString());
    resolved = detected?.type === "image" ? "INLINE" : "ATTACHMENT";
  }
  embedded.set(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE, resolved);

  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
    new ParsingEmbeddedDocumentExtractor();
  if (!extractor.shouldParseEmbedded(embedded)) return;
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    await extractor.parseEmbedded(stream, xhtml, embedded, ctx);
  } catch (error) {
    if (isFatal(error, ctx)) throw error;
    recordStreamException(parentMetadata, error);
  } finally {
    await stream.close();
  }
}

/** What the facade's detector makes of an embedded entry, or undefined without one (a direct call of the parser). */
async function detect(bytes: Uint8Array, metadata: Metadata, ctx: ParseContext): Promise<MediaType | undefined> {
  const detector = ctx.get(CONTEXT_KEYS.DETECTOR) as Detector | undefined;
  if (detector === undefined) return undefined;
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    return await detector.detect(stream, metadata, ctx);
  } catch (error) {
    if (isFatal(error, ctx)) throw error;
    return undefined;
  } finally {
    await stream.close();
  }
}

/** EmbeddedDocumentUtil.recordEmbeddedStreamException: the exception's name and message, not a stack trace. */
function recordStreamException(metadata: Metadata, error: unknown): void {
  metadata.add(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION, describeFailure(error));
}
