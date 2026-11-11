import {
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
    return new Set([MediaType.parse("application/epub+zip")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const files = boundedUnzip(await readAll(stream), ctx.limits);
    const container = files.get("META-INF/container.xml");
    if (container === undefined) {
      throw new MalformedDocumentError("Missing EPUB container.xml");
    }

    const opfPath = rootfilePath(decode(container));
    if (opfPath === null || !files.has(opfPath)) {
      throw new UnsupportedFormatError("EPUB package document not found");
    }

    const opfXml = decode(files.get(opfPath)!);
    applyOpfMetadata(metadata, opfXml);
    const base = opfPath.includes("/")
      ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
      : "";

    const manifest = epubManifest(opfXml, base);
    const spine = spineHrefs(opfXml, manifest, files);
    applyEpubNavigation(metadata, files, manifest);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const href of spine) {
      const chapter = files.get(href);
      if (chapter === undefined) continue;
      await xhtml.startElement("div", "class", "chapter");
      for (const block of htmlBlocks(decode(chapter))) {
        await xhtml.startElement("p");
        if (block.length > 0) await xhtml.characters(block);
        await xhtml.endElement("p");
      }
      await xhtml.endElement("div");
    }
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

interface ManifestItem {
  readonly href: string;
  readonly properties: string;
  readonly mediaType: string;
}

function epubManifest(
  opfXml: string,
  base: string,
): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>();
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (localName(tag.name) !== "item") return;
    const attributes = tag.attributes as Record<string, string>;
    const id = attributes.id;
    const href = attributes.href;
    if (id !== undefined && href !== undefined) {
      manifest.set(id, {
        href: resolve(base, href.split("#")[0]!),
        properties: attributes.properties ?? "",
        mediaType: attributes["media-type"] ?? "",
      });
    }
  });
  parser.write(opfXml).close();
  return manifest;
}

function spineHrefs(
  opfXml: string,
  manifest: Map<string, ManifestItem>,
  files: BoundedZip,
): string[] {
  const spine: string[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (localName(tag.name) !== "itemref") return;
    const idref = (tag.attributes as Record<string, string>).idref;
    const item = idref === undefined ? undefined : manifest.get(idref);
    if (item !== undefined) spine.push(item.href);
  });
  parser.write(opfXml).close();
  return spine.filter((href) => files.has(href));
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

function resolve(base: string, href: string): string {
  const parts = `${base}${href}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") stack.pop();
    else if (part !== "." && part.length > 0) stack.push(part);
  }
  return stack.join("/");
}

function applyOpfMetadata(metadata: Metadata, xml: string): void {
  const values: Record<string, string[]> = {};
  const root = parseXmlTree(xml);
  const metadataNode =
    root.children.find((child) => localName(child.name) === "metadata") ??
    descendantsNamed(root, "metadata")[0];
  if (metadataNode === undefined) return;

  for (const child of metadataNode.children) {
    const attributes = child.attributes;
    const key =
      attributes.property !== undefined
        ? attributes.property
        : localName(child.name);
    const value = child.text.trim();
    if (value.length > 0) (values[key] ??= []).push(value);
  }

  maybe(metadata, "dc:title", values.title?.[0]);
  maybe(metadata, "dc:language", values.language?.[0]);
  maybe(metadata, "dc:identifier", values.identifier?.[0]);
  maybe(metadata, "dc:publisher", values.publisher?.[0]);
  maybe(metadata, "dc:description", values.description?.[0]);
  maybe(metadata, "dc:date", values.date?.[0]);
  maybe(metadata, "dc:rights", values.rights?.[0]);
  maybe(metadata, "dcterms:modified", values["dcterms:modified"]?.[0]);

  for (const creator of values.creator ?? []) {
    if (creator.length > 0) metadata.add("dc:creator", creator);
  }
  for (const subject of values.subject ?? []) {
    if (subject.length > 0) metadata.add("dc:subject", subject);
  }
}

function maybe(metadata: Metadata, key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) metadata.set(key, value);
}

function htmlBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const root = parseXmlTree(xml);
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
