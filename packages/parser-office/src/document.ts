import {
  EncryptedDocumentError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  UnsupportedFormatError,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip, type BoundedZip } from "./bounded-unzip.ts";
import { emitEmbeddedItems, isChapter, readPackageDocument, type ManifestItem } from "./epub-package.ts";
import { applyOdfMetadata } from "./odf-meta.ts";
import { SaxesParser } from "saxes";
import {
  attribute,
  childrenNamed,
  descendantsNamed,
  localName,
  parseXmlTree,
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
    if (body !== undefined) await renderOdfBody(body, xhtml);

    const styles = files.get("styles.xml");
    if (styles !== undefined) {
      const styleRoot = parseXmlTree(decode(styles));
      await renderStyleRegion(styleRoot, "header", xhtml);
      await renderStyleRegion(styleRoot, "footer", xhtml);
    }

    await xhtml.endDocument();
  }
}

function findBody(root: XmlNode): XmlNode | undefined {
  for (const name of [
    "text",
    "spreadsheet",
    "presentation",
    "drawing",
    "body",
  ]) {
    const found = descendantsNamed(root, name)[0];
    if (found !== undefined && localName(found.name) === name) return found;
  }
  return undefined;
}

async function renderStyleRegion(
  root: XmlNode,
  name: string,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  for (const region of descendantsNamed(root, name)) {
    await xhtml.startElement("div", "class", name);
    await renderOdfBlocks(region, xhtml);
    await xhtml.endElement("div");
  }
}

async function renderOdfBody(
  body: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  await renderOdfBlocks(body, xhtml);
}

async function renderOdfBlocks(
  node: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  for (const child of node.children) {
    const name = localName(child.name);
    if (name === "p" || name === "h") await renderOdfParagraph(child, xhtml);
    else if (name === "list") await renderOdfList(child, xhtml);
    else if (name === "table") await renderOdfTable(child, xhtml);
    else if (name === "page") await renderOdfPage(child, xhtml);
    else if (name === "notes") {
      await xhtml.startElement("div", "class", "notes");
      await renderOdfBlocks(child, xhtml);
      await xhtml.endElement("div");
    } else if (
      name === "text-box" ||
      name === "frame" ||
      name === "text" ||
      name === "spreadsheet" ||
      name === "presentation" ||
      name === "drawing" ||
      name === "body" ||
      name === "list-item" ||
      name === "section" ||
      name === "header" ||
      name === "footer" ||
      name === "table-cell" ||
      name === "table-row" ||
      // A chart document (.odc) holds its titles and data table under office:chart/chart:chart.
      name === "chart" ||
      name === "plot-area" ||
      name === "axis" ||
      name === "title" ||
      name === "subtitle"
    ) {
      await renderOdfBlocks(child, xhtml);
    }
  }
}

async function renderOdfParagraph(
  paragraph: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const text = odfText(paragraph);
  if (text.length === 0) return;
  const heading = localName(paragraph.name) === "h";
  const element = heading ? "h1" : "p";
  await xhtml.startElement(element);
  await xhtml.characters(text);
  await xhtml.endElement(element);
}

const MAX_ODF_SPACES = 10_000;

function odfText(node: XmlNode): string {
  let text = node.text;
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      const name = localName(child.name);
      if (name === "s") {
        const count = Number(attribute(child, "c") ?? "1");
        const spaces = Number.isInteger(count) ? count : 1;
        text += " ".repeat(Math.min(Math.max(spaces, 0), MAX_ODF_SPACES));
      } else if (name === "tab") text += "\t";
      else if (name === "line-break") text += "\n";
      else if (name === "soft-page-break") continue;
      else if (name === "annotation") continue;
      else if (name === "note") {
        for (const body of descendantsNamed(child, "note-body")) {
          text += odfText(body);
        }
      } else {
        text += odfText(child);
      }
    }
  };
  visit(node);
  return text;
}

async function renderOdfList(
  list: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  await xhtml.startElement("ul");
  for (const item of childrenNamed(list, "list-item")) {
    await xhtml.startElement("li");
    await xhtml.characters(odfText(item));
    await xhtml.endElement("li");
  }
  await xhtml.endElement("ul");
}

async function renderOdfTable(
  table: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  await xhtml.startElement("table");
  for (const row of odfTableRows(table)) {
    await xhtml.startElement("tr");
    for (const cell of childrenNamed(row, "table-cell")) {
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
): Promise<void> {
  await xhtml.startElement("div", "class", "slide");
  await renderOdfBlocks(page, xhtml);
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
    const declaredRoot = container === undefined ? null : rootfilePath(decode(container));
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
        for (const block of htmlBlocks(decode(entry))) {
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
    applyOpfMetadata(metadata, opfXml);
    const base = opfPath.includes("/")
      ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
      : "";

    const document = readPackageDocument(opfXml, base);
    applyEpubNavigation(metadata, files, document.manifest);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const chapterIds = new Set<string>();
    for (const id of document.spine) {
      const item = document.manifest.get(id);
      const chapter = item !== undefined && isChapter(item) ? files.get(item.href) : undefined;
      if (chapter === undefined) continue;
      chapterIds.add(id);
      await xhtml.startElement("div", "class", "chapter");
      for (const block of htmlBlocks(decode(chapter))) {
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

function htmlBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const root = parseXmlTree(xml, { skipEntitiesOfExternalDtd: true });
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
  let text = node.text;
  for (const child of node.children) {
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
