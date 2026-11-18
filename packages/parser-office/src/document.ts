import {
  CONTEXT_KEYS,
  EncryptedDocumentError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  RipstreamError,
  UnsupportedFormatError,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
  type SegmentHints,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip, type BoundedZip } from "./bounded-unzip.ts";
import { decodeChapter } from "./epub-chapter.ts";
import { describeFailure } from "./failures.ts";
import { emitEmbeddedItems, isChapter, readPackageDocument, type ManifestItem } from "./epub-package.ts";
import { applyOdfMetadata } from "./odf-meta.ts";
import { capPages } from "./page-cap.ts";
import { SaxesParser } from "saxes";
import {
  attribute,
  childrenNamed,
  descendantsNamed,
  localName,
  parseXmlTree,
  parseXmlTreeUntilError,
  type XmlNode,
} from "./xml-tree.ts";

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function readAll(stream: RipstreamInputStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

const ODF_TYPES = [
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.text-template",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet-template",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.presentation-template",
  "application/vnd.oasis.opendocument.graphics",
  "application/vnd.oasis.opendocument.graphics-template",
  // The rest of OpenDocumentParser.SUPPORTED_TYPES in Tika 4.2.0 (tikajs-68os.12). Its x-vnd.oasis.* spellings are
  // aliases of these in the media type registry, so they resolve here without being listed.
  "application/vnd.sun.xml.writer",
  "application/vnd.oasis.opendocument.chart",
  "application/vnd.oasis.opendocument.chart-template",
  "application/vnd.oasis.opendocument.image",
  "application/vnd.oasis.opendocument.image-template",
  "application/vnd.oasis.opendocument.formula",
  "application/vnd.oasis.opendocument.formula-template",
  "application/vnd.oasis.opendocument.text-master",
  "application/vnd.oasis.opendocument.text-web",
];

/** OpenDocument text/spreadsheet/presentation/drawing parser. */
export class OpenDocumentParser implements Parser {
  readonly name = "OpenDocumentParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(ODF_TYPES.map((type) => MediaType.parse(type)!));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const files = boundedUnzip(await readAll(stream), ctx.limits);
    if (!files.has("content.xml")) {
      throw new MalformedDocumentError("Missing ODF content.xml");
    }

    const meta = files.get("meta.xml");
    if (meta !== undefined) applyOdfMetadata(metadata, decode(meta));

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    const root = parseXmlTree(decode(files.get("content.xml")!));
    const body = findBody(root);
    const kind = body === undefined ? "" : localName(body.name);
    if (kind === "spreadsheet" || kind === "presentation") {
      const unit = kind === "spreadsheet" ? "table" : "page";
      capPages(ctx, body!.children.filter((child) => localName(child.name) === unit).length, unit === "table" ? "sheets" : "slides");
    }
    if (body !== undefined) await renderOdfBody(body, xhtml, ctx.get(CONTEXT_KEYS.SEGMENT_HINTS));

    const styles = files.get("styles.xml");
    if (styles !== undefined) {
      const styleRoot = parseXmlTree(decode(styles));
      await renderStyleRegions(styleRoot, xhtml);
    }

    await xhtml.endDocument();
  }
}

const ODF_BODY_KINDS = ["text", "spreadsheet", "presentation", "drawing", "body"];

function findBody(root: XmlNode): XmlNode | undefined {
  // The kind of document is a child of office:body. Searching the whole tree would match number:text and similar
  // elements in the automatic styles, which come first in content.xml, and render nothing.
  const officeBody = descendantsNamed(root, "body")[0];
  const scope = officeBody ?? root;
  for (const name of ODF_BODY_KINDS) {
    const found = (officeBody === undefined ? descendantsNamed(scope, name) : childrenNamed(scope, name))[0];
    if (found !== undefined && localName(found.name) === name) return found;
  }
  return officeBody;
}

/** The six header and footer regions of a master page. */
const STYLE_REGIONS: ReadonlySet<string> = new Set([
  "header",
  "footer",
  "header-left",
  "footer-left",
  "header-first",
  "footer-first",
]);

/** Each header and footer region in the order styles.xml has them, as its paragraphs alone: Tika 4.2.0 wraps them in nothing (tikajs-uay4). */
async function renderStyleRegions(node: XmlNode, xhtml: XHTMLContentHandler): Promise<void> {
  for (const child of node.children) {
    if (STYLE_REGIONS.has(localName(child.name))) await renderOdfBlocks(child, xhtml);
    else await renderStyleRegions(child, xhtml);
  }
}

async function renderOdfBody(
  body: XmlNode,
  xhtml: XHTMLContentHandler,
  hints?: SegmentHints,
): Promise<void> {
  await renderOdfBlocks(body, xhtml, hints);
}

/** `hints`: the body's tables say their own row and column numbers to the segments (the header and footer regions get none). */
async function renderOdfBlocks(
  node: XmlNode,
  xhtml: XHTMLContentHandler,
  hints?: SegmentHints,
): Promise<void> {
  for (const child of node.children) await renderOdfChild(child, xhtml, hints);
}

/**
 * The content of a text: element that is not a paragraph (a list, a list item, a section): the whitespace between its children is
 * text, as Tika 4.2.0 passes it (a pretty-printed list is "\n  \t\n    item\n\n  \n"), where office:text's own is not (tikajs-uay4).
 */
async function renderOdfMixed(
  node: XmlNode,
  xhtml: XHTMLContentHandler,
  hints?: SegmentHints,
): Promise<void> {
  for (const part of node.content) {
    if (typeof part === "string") {
      if (part.length > 0) await xhtml.characters(part);
    } else {
      await renderOdfChild(part, xhtml, hints);
    }
  }
}

async function renderOdfChild(
  child: XmlNode,
  xhtml: XHTMLContentHandler,
  hints?: SegmentHints,
): Promise<void> {
  const name = localName(child.name);
  if (name === "p" || name === "h") await renderOdfParagraph(child, xhtml, hints);
  else if (name === "list-item") {
    await xhtml.startElement("li");
    await renderOdfMixed(child, xhtml, hints);
    await xhtml.endElement("li");
  } else if (name === "list") await renderOdfList(child, xhtml, hints);
  else if (name === "section") await renderOdfMixed(child, xhtml, hints);
  else if (name === "table") await renderOdfTable(child, xhtml, hints);
  else if (name === "page") await renderOdfPage(child, xhtml, hints);
  else if (name === "notes") {
    await xhtml.startElement("div", "class", "notes");
    await renderOdfBlocks(child, xhtml, hints);
    await xhtml.endElement("div");
  } else if (
    name === "text-box" ||
    name === "frame" ||
    name === "text" ||
    name === "spreadsheet" ||
    name === "presentation" ||
    name === "drawing" ||
    name === "body" ||
    name === "header" ||
    name === "footer" ||
    name === "header-left" ||
    name === "footer-left" ||
    name === "header-first" ||
    name === "footer-first" ||
    name === "table-cell" ||
    name === "table-row" ||
    // A chart document (.odc) holds its titles and data table under office:chart/chart:chart.
    name === "chart" ||
    name === "plot-area" ||
    name === "axis" ||
    name === "title" ||
    name === "subtitle"
  ) {
    await renderOdfBlocks(child, xhtml, hints);
  }
}

async function renderOdfParagraph(
  paragraph: XmlNode,
  xhtml: XHTMLContentHandler,
  hints?: SegmentHints,
): Promise<void> {
  const heading = localName(paragraph.name) === "h";
  // office:annotation (a comment) inside a paragraph ends the text before it and is a block of its own; the text after it
  // is a paragraph again (Tika 4.2.0, tikajs-u03v).
  let run: (XmlNode | string)[] = [];
  const flush = async (): Promise<void> => {
    const text = odfText({ ...paragraph, content: run });
    run = [];
    // An empty paragraph writes an empty p (one newline), as Tika's does; an empty heading writes nothing.
    if (text.length === 0) {
      if (heading || paragraph.content.length > 0) return;
      await xhtml.startElement("p");
      await xhtml.endElement("p");
      return;
    }
    // Tika 4.2.0 writes a heading's text with no line break after it, so the block after it starts on the same line
    // ('TB' for a heading T and a paragraph B) and a trailing heading has no final newline. `figcaption` is a block to
    // the segment hints (which are told the level) without a line break of its own in the XHTML handler (tikajs-z36j).
    if (heading) {
      const level = Number(attribute(paragraph, "outline-level") ?? 1);
      hints?.heading(Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1);
      await xhtml.startElement("figcaption");
      await xhtml.characters(text);
      await xhtml.endElement("figcaption");
      return;
    }
    await xhtml.startElement("p");
    await xhtml.characters(text);
    await xhtml.endElement("p");
  };
  for (const part of paragraph.content) {
    if (typeof part !== "string" && localName(part.name) === "annotation") {
      await flush();
      await renderOdfAnnotation(part, xhtml);
    } else {
      run.push(part);
    }
  }
  await flush();
}

/**
 * The body of an office:annotation. Oracle (Tika 4.2.0): each run of paragraphs directly in it is one block in which a
 * paragraph ends in a space and one that follows another starts with one, so "P1" and "P2" read "P1  P2 "; the first
 * block, when it is such a run, starts with the literal text "&#32;" (a quirk of Tika's handler, kept so the text agrees).
 * Lists and tables in it are blocks as elsewhere; direct text, the creator and the date are not written.
 */
async function renderOdfAnnotation(annotation: XmlNode, xhtml: XHTMLContentHandler): Promise<void> {
  let run = "";
  let inRun = false;
  let first = true;
  const flush = async (): Promise<void> => {
    if (!inRun) return;
    await xhtml.startElement("p");
    await xhtml.characters(run);
    await xhtml.endElement("p");
    run = "";
    inRun = false;
  };
  for (const child of annotation.children) {
    if (localName(child.name) === "p") {
      if (!inRun) run = first ? "&#32;" : "";
      else run += " ";
      run += `${odfText(child)} `;
      inRun = true;
    } else {
      await flush();
      await renderOdfBlocks({ ...annotation, children: [child] }, xhtml);
    }
    // The creator and the date before the first block do not make it later.
    if (/^(p|h|list|table)$/.test(localName(child.name))) first = false;
  }
  await flush();
}

const MAX_ODF_SPACES = 10_000;

function odfText(node: XmlNode): string {
  let text = "";
  const visit = (current: XmlNode): void => {
    for (const part of current.content) {
      if (typeof part === "string") {
        text += part;
        continue;
      }
      const child = part;
      const name = localName(child.name);
      if (name === "s") {
        const count = Number(attribute(child, "c") ?? "1");
        const spaces = Number.isInteger(count) ? count : 1;
        text += " ".repeat(Math.min(Math.max(spaces, 0), MAX_ODF_SPACES));
      } else if (name === "tab") text += "\t";
      else if (name === "line-break") text += "\n";
      else if (name === "soft-page-break") continue;
      // Tika's handler passes text only from text: elements and not from these two, whose text is the page the reader is on.
      else if (name === "annotation" || name === "page-number" || name === "page-count") continue;
      else if (name === "note") text += odfNote(child);
      else {
        text += odfText(child);
      }
    }
  };
  visit(node);
  return text;
}

/**
 * A footnote or endnote in the text of its paragraph (Tika 4.2.0, tikajs-uay4): its citation, then a space, then the paragraphs of
 * its body, each ending in a space and one that follows another starting with one ("A1 P1  P2 B"). A note with no citation still
 * has the space.
 */
function odfNote(note: XmlNode): string {
  const citation = childrenNamed(note, "note-citation").map((node) => odfText(node)).join("");
  const body = childrenNamed(note, "note-body")
    .flatMap((node) => childrenNamed(node, "p"))
    .map((paragraph, index) => `${index === 0 ? "" : " "}${odfText(paragraph)} `)
    .join("");
  return `${citation} ${body}`;
}

/** A list is a ul of li, each holding its own paragraphs and lists: Tika's text has each of their line breaks (tikajs-uay4). */
async function renderOdfList(
  list: XmlNode,
  xhtml: XHTMLContentHandler,
  hints?: SegmentHints,
): Promise<void> {
  await xhtml.startElement("ul");
  await renderOdfMixed(list, xhtml, hints);
  await xhtml.endElement("ul");
}

async function renderOdfTable(
  table: XmlNode,
  xhtml: XHTMLContentHandler,
  hints?: SegmentHints,
): Promise<void> {
  await xhtml.startElement("table");
  // Segments only: the sheet's own numbers. A row or a cell may stand for several (`number-rows-repeated`,
  // `number-columns-repeated`) and a covered cell is a column the merged cell before it spans: the table writes none of those.
  let rowNumber = 1;
  for (const row of odfTableRows(table)) {
    hints?.row(rowNumber);
    rowNumber += odfRepeat(row, "number-rows-repeated");
    await xhtml.startElement("tr");
    let column = 1;
    for (const cell of row.children) {
      const name = localName(cell.name);
      if (name === "covered-table-cell") column += odfRepeat(cell, "number-columns-repeated");
      if (name !== "table-cell") continue;
      hints?.col(column);
      column += odfRepeat(cell, "number-columns-repeated");
      await xhtml.startElement("td");
      const text = cell.children
        .map((child) => odfText(child))
        .filter((value) => value.length > 0)
        .join("\n");
      if (text.length > 0) await xhtml.characters(text);
      await xhtml.endElement("td");
    }
    await xhtml.endElement("tr");
  }
  await xhtml.endElement("table");
}

/** How many rows or columns an element stands for: its repeat attribute, 1 when absent or not a count. */
function odfRepeat(node: XmlNode, attributeName: string): number {
  const count = Number(attribute(node, attributeName) ?? "1");
  return Number.isSafeInteger(count) && count > 1 ? count : 1;
}

const ODF_ROW_WRAPPERS = new Set(["table-header-rows", "table-rows", "table-row-group"]);

/** The rows of a table in document order, whether they are its children or sit in a header, body or group wrapper. */
function odfTableRows(node: XmlNode): XmlNode[] {
  const rows: XmlNode[] = [];
  for (const child of node.children) {
    const name = localName(child.name);
    if (name === "table-row") rows.push(child);
    else if (ODF_ROW_WRAPPERS.has(name)) rows.push(...odfTableRows(child));
  }
  return rows;
}

async function renderOdfPage(
  page: XmlNode,
  xhtml: XHTMLContentHandler,
  hints?: SegmentHints,
): Promise<void> {
  await xhtml.startElement("div", "class", "slide");
  await renderOdfBlocks(page, xhtml, hints);
  await xhtml.endElement("div");
}

function assign(metadata: Metadata, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim().length > 0) metadata.set(key, value.trim());
}

/** EPUB 2/3 parser using OPF spine order. */
export class EpubParser implements Parser {
  readonly name = "EpubParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/epub+zip")!, MediaType.parse("application/x-ibooks+zip")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const files = boundedUnzip(await readAll(stream), ctx.limits);
    const mimetype = files.get("mimetype");
    if (mimetype !== undefined) {
      const declared = decode(mimetype).trim();
      if (declared.length > 0) metadata.set("Content-Type", declared);
    }
    const encryption = files.get("META-INF/encryption.xml");
    if (encryption !== undefined && decode(encryption).includes("CipherReference")) {
      // Tika writes what it can and then throws EncryptedDocumentException when the encryption file names encrypted
      // items; before that point no chapter has been written, which is also a clean refusal.
      throw new EncryptedDocumentError("EPUB contains encrypted items");
    }
    const container = files.get("META-INF/container.xml");
    const declaredRoot = container === undefined ? null : wellFormed("container.xml", () => rootfilePath(decode(container)));
    // Tika's getRoot falls back to the first .opf entry when container.xml is absent or names nothing there.
    const opfPath =
      declaredRoot !== null && files.has(declaredRoot)
        ? declaredRoot
        : files.names.find((name) => name.toLowerCase().endsWith(".opf")) ?? null;
    if (opfPath === null || !files.has(opfPath)) {
      // Tika's fallback for a truncated EPUB whose OPF is past the cut: write every HTML/XHTML entry in archive order,
      // then fail so the caller knows the spine could not be followed.
      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();
      let recovered = 0;
      for (const name of files.names) {
        const lower = name.toLowerCase();
        if (!(lower.endsWith(".xhtml") || lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xml"))) continue;
        if (lower.endsWith(".opf")) continue;
        const entry = files.get(name);
        if (entry === undefined) continue;
        await xhtml.startElement("div", "class", "chapter");
        for (const block of wellFormed(`chapter ${name}`, () => htmlBlocks(decodeChapter(entry)))) {
          await xhtml.startElement("p");
          if (block.length > 0) await xhtml.characters(block);
          await xhtml.endElement("p");
        }
        await xhtml.endElement("div");
        recovered++;
      }
      await xhtml.endDocument();
      throw new MalformedDocumentError(`EPUB: no package document; recovered ${recovered} HTML entries without a spine`);
    }

    const opfXml = decode(files.get(opfPath)!);
    wellFormed("package document", () => applyOpfMetadata(metadata, opfXml));
    const base = opfPath.includes("/")
      ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
      : "";

    const document = wellFormed("package document", () => readPackageDocument(opfXml, base));
    applyEpubNavigation(metadata, files, document.manifest);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const chapterIds = new Set<string>();
    for (const id of document.spine) {
      ctx.throwIfAborted();
      const item = document.manifest.get(id);
      const chapter = item !== undefined && isChapter(item) ? files.get(item.href) : undefined;
      if (chapter === undefined) continue;
      chapterIds.add(id);
      await xhtml.startElement("div", "class", "chapter");
      // Tika's EpubContentParser throws on a chapter that is not well-formed; the throw is recorded on the container
      // (TIKA-237) and the next chapter is read, the text of this one up to the error kept.
      const blocks = htmlBlocks(decodeChapter(chapter), (failure) => {
        metadata.add(
          "tk:exception:container-exception",
          describeFailure(new MalformedDocumentError(`EPUB chapter ${item?.href ?? id} is not well-formed: ${failure.message}`, { cause: failure })),
        );
      });
      for (const block of blocks) {
        await xhtml.startElement("p");
        if (block.length > 0) await xhtml.characters(block);
        await xhtml.endElement("p");
      }
      await xhtml.endElement("div");
    }
    await emitEmbeddedItems(document, chapterIds, files, xhtml, metadata, ctx);
    await xhtml.endDocument();
  }
}

/** Runs a read of one package file, naming the file when its XML is not well-formed instead of surfacing the raw saxes error. */
function wellFormed<T>(what: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof RipstreamError || !(error instanceof Error)) throw error;
    throw new MalformedDocumentError(`EPUB ${what} is not well-formed: ${error.message}`, { cause: error });
  }
}

function rootfilePath(xml: string): string | null {
  let path: string | null = null;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (localName(tag.name) === "rootfile") {
      const fullPath = (tag.attributes as Record<string, string>)["full-path"];
      if (fullPath !== undefined) path = fullPath;
    }
  });
  parser.write(xml).close();
  return path;
}

function applyEpubNavigation(
  metadata: Metadata,
  files: BoundedZip,
  manifest: Map<string, ManifestItem>,
): void {
  let cover: string | undefined;
  let nav: string | undefined;
  for (const item of manifest.values()) {
    const properties = item.properties.split(/\s+/);
    if (properties.includes("cover-image")) cover = item.href;
    if (properties.includes("nav")) nav = item.href;
    if (item.mediaType === "application/x-dtbncx+xml" && nav === undefined) {
      nav = item.href;
    }
  }
  if (cover !== undefined) metadata.set("epub:cover", cover);

  if (nav !== undefined) {
    const data = files.get(nav);
    if (data !== undefined) {
      for (const label of navigationLabels(decode(data))) {
        metadata.add("epub:toc", label);
      }
    }
  }
}

function navigationLabels(xml: string): string[] {
  const labels: string[] = [];
  const root = parseXmlTree(xml);
  for (const navPoint of descendantsNamed(root, "navPoint")) {
    const text = descendantsNamed(navPoint, "text")[0];
    if (text !== undefined && text.text.trim().length > 0) {
      labels.push(text.text.trim());
    }
  }
  const nav = descendantsNamed(root, "nav").find(
    (node) => attribute(node, "type") === "toc",
  );
  if (nav !== undefined) {
    for (const anchor of descendantsNamed(nav, "a")) {
      if (anchor.text.trim().length > 0) labels.push(anchor.text.trim());
    }
  }
  return labels;
}

/** The Dublin Core elements DcXMLParser reads, each as a list of distinct values. */
const DC_BAGS = [
  "title",
  "subject",
  "creator",
  "description",
  "publisher",
  "contributor",
  "type",
  "identifier",
  "language",
  "source",
  "rights",
] as const;

/**
 * The OPF's metadata as Tika's OPFParser (a DcXMLParser) reads it: a list of distinct values for each Dublin Core bag, and for
 * the two single-valued elements the last value that differs, dc:date as dcterms:created and dc:format. dcterms:modified
 * from an EPUB 3 meta element is not Tika's; it is kept.
 */
function applyOpfMetadata(metadata: Metadata, xml: string): void {
  const root = parseXmlTree(xml);
  // Tika's OPFParser sets these before the metadata bag: the package version, and a layout that a spine item or meta
  // element can make pre-paginated.
  const packageNode = root.name === "package" ? root : descendantsNamed(root, "package")[0];
  const version = packageNode === undefined ? undefined : attribute(packageNode, "version");
  if (version !== undefined && version.trim().length > 0) metadata.set("epub:version", version.trim());
  metadata.set("epub:rendition:layout", "reflowable");
  for (const itemref of descendantsNamed(root, "itemref")) {
    if ((attribute(itemref, "properties") ?? "").includes("rendition:layout-pre-paginated")) {
      metadata.set("epub:rendition:layout", "pre-paginated");
    }
  }
  for (const meta of descendantsNamed(root, "meta")) {
    if (attribute(meta, "property") === "rendition:layout" && meta.text.trim() === "pre-paginated") {
      metadata.set("epub:rendition:layout", "pre-paginated");
    }
  }
  const metadataNode =
    root.children.find((child) => localName(child.name) === "metadata") ??
    descendantsNamed(root, "metadata")[0];
  if (metadataNode === undefined) return;

  for (const child of metadataNode.children) {
    const value = child.text.trim();
    if (value.length === 0) continue;
    const property = child.attributes.property;
    if (property === "dcterms:modified") {
      metadata.set("dcterms:modified", value);
      continue;
    }
    const term = localName(child.name);
    if ((DC_BAGS as readonly string[]).includes(term)) addDistinct(metadata, `dc:${term}`, value);
    else if (term === "date") metadata.set("dcterms:created", value);
    else if (term === "format") metadata.set("dc:format", value);
  }
}

function addDistinct(metadata: Metadata, key: string, value: string): void {
  if (!metadata.getAll(key).includes(value)) metadata.add(key, value);
}

function htmlBlocks(xml: string, onFailure?: (failure: Error) => void): string[] {
  const blocks: string[] = [];
  const { root, failure } = parseXmlTreeUntilError(xml, { skipEntitiesOfExternalDtd: true });
  if (failure !== undefined) {
    if (onFailure === undefined) throw failure;
    onFailure(failure);
  }
  const body =
    root.children
      .flatMap((child) => descendantsNamed(child, "body"))
      .concat(root.children.filter((child) => localName(child.name) === "body"))[0] ??
    root;

  const blockNames = new Set(["p", "div", "li", "blockquote", "pre", "td", "th"]);
  const visit = (node: XmlNode): void => {
    for (const child of node.children) {
      const name = localName(child.name).toLowerCase();
      const heading = /^h[1-6]$/.test(name);
      if (blockNames.has(name) || heading) {
        const text = htmlText(child).replace(/\s+/g, " ").trim();
        if (text.length > 0) blocks.push(text);
      } else {
        visit(child);
      }
    }
  };
  visit(body);
  return blocks;
}

function htmlText(node: XmlNode): string {
  let text = "";
  for (const part of node.content) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const child = part;
    const name = localName(child.name).toLowerCase();
    if (name === "script" || name === "style") continue;
    if (name === "br") {
      text += "\n";
      continue;
    }
    text += htmlText(child);
  }
  return text;
}
