import {
  CONTEXT_KEYS,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  UnsupportedFormatError,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type EmbeddedDocumentExtractor,
  type Parser,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { OpcPackage } from "./opc.ts";
import {
  attribute,
  childrenNamed,
  descendantsNamed,
  localName,
  parseXmlTree,
  type XmlNode,
} from "./xml-tree.ts";
import { formatExcelDate, isDateFormat } from "./excel-format.ts";

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * OOXML parser for docx/xlsx/pptx. ZIP parts are read with fflate, XML is
 * walked as a minimal element tree; no macros are executed.
 */
export class OoxmlParser implements Parser {
  readonly name = "OOXMLParser";
  readonly capabilities = { unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [DOCX, XLSX, PPTX, "application/x-tika-ooxml"].map((type) =>
        MediaType.parse(type)!,
      ),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const prefix = await stream.peek(8);
    if (
      prefix.length >= 8 &&
      prefix[0] === 0xd0 &&
      prefix[1] === 0xcf &&
      prefix[2] === 0x11 &&
      prefix[3] === 0xe0
    ) {
      throw new EncryptedDocumentError(
        "OOXML document is encrypted or wrapped in an OLE2 container",
      );
    }
    const packageFile = await OpcPackage.open(stream, ctx.limits);
    let files: Record<string, Uint8Array>;
    try {
      if (packageFile.has("EncryptedPackage") || packageFile.has("EncryptionInfo")) {
        throw new EncryptedDocumentError("OOXML document is encrypted");
      }
      files = await collectParts(packageFile);
      if (
        packageFile.has("word/vbaProject.bin") ||
        packageFile.has("xl/vbaProject.bin") ||
        packageFile.has("ppt/vbaProject.bin")
      ) {
        metadata.set("msoffice:has-macros", "true");
      }
    } finally {
      await packageFile.close();
    }

    applyPackageMetadata(metadata, files);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    if (files["word/document.xml"] !== undefined) {
      await renderWord(files, xhtml);
    } else if (files["xl/workbook.xml"] !== undefined) {
      await renderWorkbook(files, xhtml);
    } else if (files["ppt/presentation.xml"] !== undefined) {
      await renderPresentation(files, xhtml);
    } else {
      throw new UnsupportedFormatError("Unrecognized OOXML package");
    }

    await renderEmbeddedParts(files, xhtml, ctx);
    await xhtml.endDocument();
  }
}

async function collectParts(
  packageFile: OpcPackage,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const name of packageFile.names) {
    if (!neededPart(name)) continue;
    files[name] = await packageFile.read(name);
  }
  return files;
}

const SHARED_PARTS = /^docProps\/(core|app|custom)\.xml$/;
const DOCX_PARTS =
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$|^word\/(charts\/chart\d+\.xml|diagrams\/data\d+\.xml|embeddings\/[^/]+|media\/[^/]+)$/;
const XLSX_PARTS =
  /^xl\/(workbook|sharedStrings|styles)\.xml$|^xl\/(worksheets\/sheet\d+\.xml|charts\/chart\d+\.xml|embeddings\/[^/]+|media\/[^/]+)$/;
const PPTX_PARTS =
  /^ppt\/(presentation)\.xml$|^ppt\/(slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml|charts\/chart\d+\.xml|diagrams\/data\d+\.xml|embeddings\/[^/]+|media\/[^/]+)$/;

function neededPart(name: string): boolean {
  if (SHARED_PARTS.test(name)) return true;
  if (name.startsWith("word/")) return DOCX_PARTS.test(name);
  if (name.startsWith("xl/")) return XLSX_PARTS.test(name);
  if (name.startsWith("ppt/")) return PPTX_PARTS.test(name);
  return false;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ---------------------------------------------------------------------------
// WordprocessingML
// ---------------------------------------------------------------------------

async function renderWord(
  files: Record<string, Uint8Array>,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const document = parsePart(files, "word/document.xml");
  if (document !== undefined) {
    const body = findFirst(document, "body") ?? document;
    await renderWordBlocks(body, xhtml);
  }

  await renderWordPartGroup(files, /^word\/header\d*\.xml$/, "header", xhtml);
  await renderWordPartGroup(files, /^word\/footer\d*\.xml$/, "footer", xhtml);
  await renderNotes(files, "word/footnotes.xml", "footnote", xhtml);
  await renderNotes(files, "word/endnotes.xml", "endnote", xhtml);
  await renderNotes(files, "word/comments.xml", "comment", xhtml);
}

async function renderWordPartGroup(
  files: Record<string, Uint8Array>,
  pattern: RegExp,
  className: string,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  for (const name of Object.keys(files).filter((key) => pattern.test(key)).sort()) {
    const root = parsePart(files, name);
    if (root === undefined) continue;
    const content = findFirst(root, "hdr") ?? findFirst(root, "ftr") ?? root;
    await xhtml.startElement("div", "class", className);
    await renderWordBlocks(content, xhtml);
    await xhtml.endElement("div");
  }
}

async function renderNotes(
  files: Record<string, Uint8Array>,
  part: string,
  className: string,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const root = parsePart(files, part);
  if (root === undefined) return;
  const notes = childrenNamed(root, "footnotes")
    .flatMap((node) => node.children)
    .concat(childrenNamed(root, "endnotes").flatMap((node) => node.children))
    .concat(childrenNamed(root, "comments").flatMap((node) => node.children))
    .filter((node) => localName(node.name) === className);
  if (notes.length === 0) {
    for (const node of descendantsNamed(root, className)) notes.push(node);
  }
  for (const note of notes) {
    const type = attribute(note, "type");
    if (type === "separator" || type === "continuationSeparator") continue;
    await xhtml.startElement("div", "class", className);
    await renderWordBlocks(note, xhtml);
    await xhtml.endElement("div");
  }
}

async function renderWordBlocks(
  node: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  for (const child of node.children) {
    const name = localName(child.name);
    if (name === "p") await renderWordParagraph(child, xhtml);
    else if (name === "tbl") await renderWordTable(child, xhtml);
    else if (name === "sdt" || name === "sdtContent" || name === "customXml") {
      await renderWordBlocks(child, xhtml);
    } else if (name === "ins" || name === "del" || name === "moveTo" || name === "moveFrom") {
      await renderWordBlocks(child, xhtml);
    } else if (name === "body" || name === "hdr" || name === "ftr") {
      await renderWordBlocks(child, xhtml);
    }
  }
}

async function renderWordParagraph(
  paragraph: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const text = wordParagraphText(paragraph);
  if (text.length > 0) {
    await xhtml.startElement("p");
    await xhtml.characters(text);
    await xhtml.endElement("p");
  }
  for (const box of descendantsNamed(paragraph, "txbxContent")) {
    await renderWordBlocks(box, xhtml);
  }
}

function wordParagraphText(node: XmlNode): string {
  let text = "";
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      const name = localName(child.name);
      if (name === "txbxContent" || name === "instrText") continue;
      if (name === "t" || name === "delText") text += child.text;
      else if (name === "tab") text += "\t";
      else if (name === "br" || name === "cr") text += "\n";
      else if (name === "noBreakHyphen") text += "-";
      else if (name === "softHyphen") continue;
      else if (name === "sym") {
        const code = attribute(child, "char");
        if (code !== undefined) {
          const value = Number.parseInt(code, 16);
          if (Number.isFinite(value)) text += String.fromCodePoint(value);
        }
      } else visit(child);
    }
  };
  visit(node);
  return text;
}

async function renderWordTable(
  table: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  await xhtml.startElement("table");
  for (const row of childrenNamed(table, "tr")) {
    await xhtml.startElement("tr");
    for (const cell of childrenNamed(row, "tc")) {
      await xhtml.startElement("td");
      await renderWordBlocks(cell, xhtml);
      await xhtml.endElement("td");
    }
    await xhtml.endElement("tr");
  }
  await xhtml.endElement("table");
}

// ---------------------------------------------------------------------------
// SpreadsheetML
// ---------------------------------------------------------------------------

interface SheetCell {
  readonly value: string;
  readonly styleIndex: number;
  readonly type: string;
}

interface SheetRow {
  readonly cells: SheetCell[];
}

interface Styles {
  readonly dateStyles: boolean[];
  readonly percentStyles: boolean[];
  readonly decimals: number[];
}

function parseStyles(xml: string | undefined): Styles {
  const dateStyles: boolean[] = [];
  const percentStyles: boolean[] = [];
  const decimals: number[] = [];
  if (xml === undefined) return { dateStyles, percentStyles, decimals };

  const root = parseXmlTree(xml);
  const custom = new Map<number, string>();
  for (const numFmt of descendantsNamed(root, "numFmt")) {
    const id = Number(attribute(numFmt, "numFmtId"));
    const code = attribute(numFmt, "formatCode");
    if (Number.isFinite(id) && code !== undefined) custom.set(id, code);
  }

  const cellXfs = findFirst(root, "cellXfs");
  const formats = cellXfs === undefined ? [] : childrenNamed(cellXfs, "xf");
  for (const xf of formats) {
    const id = Number(attribute(xf, "numFmtId") ?? "0");
    const code = custom.get(id);
    const builtinDate = id >= 14 && id <= 22 || id >= 45 && id <= 47;
    dateStyles.push(code === undefined ? builtinDate : isDateFormat(code));
    percentStyles.push(id === 9 || id === 10);
    decimals.push(id === 10 ? 2 : 0);
  }
  return { dateStyles, percentStyles, decimals };
}

function parseSheet(xml: string, shared: string[]): SheetRow[] {
  const rows: SheetRow[] = [];
  let row: SheetCell[] = [];
  let text = "";
  let cellType = "";
  let styleIndex = 0;
  let inInline = false;

  let totalCells = 0;
  const root = parseXmlTree(xml);
  for (const rowNode of descendantsNamed(root, "row")) {
    row = [];
    let nextColumn = 0;
    for (const cellNode of childrenNamed(rowNode, "c")) {
      const reference = attribute(cellNode, "r");
      const column = reference === undefined ? nextColumn : columnIndex(reference);
      totalCells += column + 1 - nextColumn;
      if (totalCells > MAX_SHEET_CELLS) {
        throw new LimitExceededError(`Sheet exceeds ${MAX_SHEET_CELLS} cells`);
      }
      while (nextColumn < column) {
        row.push({ value: "", styleIndex: 0, type: "" });
        nextColumn++;
      }

      cellType = attribute(cellNode, "t") ?? "";
      styleIndex = Number(attribute(cellNode, "s") ?? "0");
      text = "";
      inInline = false;

      const visit = (node: XmlNode): void => {
        for (const child of node.children) {
          const name = localName(child.name);
          if (name === "v") {
            text += child.text;
          } else if (name === "is") {
            inInline = true;
            visit(child);
            inInline = false;
          } else if (name === "t" && inInline) {
            text += child.text;
          } else if (name !== "f") {
            visit(child);
          }
        }
      };
      visit(cellNode);

      row.push({
        value: cellType === "s" ? (shared[Number(text)] ?? "") : text,
        styleIndex,
        type: cellType,
      });
      nextColumn = column + 1;
    }
    rows.push({ cells: row });
  }
  return rows;
}

const MAX_COLUMNS = 16_384;
/** Cap on materialized (real plus padding) cells per sheet. */
const MAX_SHEET_CELLS = 1_000_000;

function columnIndex(reference: string): number {
  let value = 0;
  for (const char of reference) {
    const code = char.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) break;
    value = value * 26 + (code - 64);
    if (value > MAX_COLUMNS) {
      throw new MalformedDocumentError(`Cell reference column out of range: ${reference}`);
    }
  }
  return Math.max(0, value - 1);
}

function formatCell(cell: SheetCell, styles: Styles): string {
  if (cell.type === "s" || cell.type === "str" || cell.type === "inlineStr") {
    return cell.value;
  }
  if (cell.value.length === 0) return "";
  const number = Number(cell.value);
  if (!Number.isFinite(number)) return cell.value;

  if (styles.percentStyles[cell.styleIndex] === true) {
    const decimals = styles.decimals[cell.styleIndex] ?? 0;
    return `${(number * 100).toFixed(decimals)}%`;
  }
  if (styles.dateStyles[cell.styleIndex] === true) {
    return formatExcelDate(number);
  }
  return cell.value;
}

async function renderWorkbook(
  files: Record<string, Uint8Array>,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const shared = sharedStrings(parsePart(files, "xl/sharedStrings.xml"));
  const styles = parseStyles(
    files["xl/styles.xml"] === undefined
      ? undefined
      : decode(files["xl/styles.xml"]!),
  );

  const workbook = parsePart(files, "xl/workbook.xml");
  const names = workbook === undefined ? [] : sheetNames(workbook);

  const sheetFiles = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b));

  for (let index = 0; index < sheetFiles.length; index++) {
    const name = names[index];
    await xhtml.startElement("div", "class", "sheet");
    if (name !== undefined) {
      await xhtml.startElement("h1");
      await xhtml.characters(name);
      await xhtml.endElement("h1");
    }
    const rows = parseSheet(decode(files[sheetFiles[index]!]!), shared);
    await xhtml.startElement("table");
    for (const row of rows) {
      await xhtml.startElement("tr");
      for (const cell of row.cells) {
        await xhtml.startElement("td");
        const value = formatCell(cell, styles);
        if (value.length > 0) await xhtml.characters(value);
        await xhtml.endElement("td");
      }
      await xhtml.endElement("tr");
    }
    await xhtml.endElement("table");
    await xhtml.endElement("div");
  }
}

function sharedStrings(root: XmlNode | undefined): string[] {
  if (root === undefined) return [];
  return descendantsNamed(root, "si").map((item) =>
    descendantsNamed(item, "t")
      .map((text) => text.text)
      .join(""),
  );
}

function sheetNames(root: XmlNode): string[] {
  return descendantsNamed(root, "sheet")
    .map((sheet) => attribute(sheet, "name"))
    .filter((name): name is string => name !== undefined);
}

function sheetNumber(name: string): number {
  const match = /sheet(\d+)\.xml$/.exec(name);
  return match === null ? 0 : Number(match[1]);
}

// ---------------------------------------------------------------------------
// PresentationML
// ---------------------------------------------------------------------------

async function renderPresentation(
  files: Record<string, Uint8Array>,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const slides = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  for (const slide of slides) {
    const root = parsePart(files, slide);
    if (root === undefined) continue;
    await xhtml.startElement("div", "class", "slide");
    await renderDrawingBlocks(root, xhtml);
    await xhtml.endElement("div");

    const notes = notesPart(files, slide);
    if (notes !== undefined) {
      await xhtml.startElement("div", "class", "notes");
      await renderDrawingBlocks(notes, xhtml);
      await xhtml.endElement("div");
    }
  }
}

function notesPart(
  files: Record<string, Uint8Array>,
  slide: string,
): XmlNode | undefined {
  const number = slideNumber(slide);
  return parsePart(files, `ppt/notesSlides/notesSlide${number}.xml`);
}

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match === null ? 0 : Number(match[1]);
}

async function renderDrawingBlocks(
  node: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  for (const child of node.children) {
    const name = localName(child.name);
    if (name === "p") await renderDrawingParagraph(child, xhtml);
    else if (name === "tbl") await renderDrawingTable(child, xhtml);
    else await renderDrawingBlocks(child, xhtml);
  }
}

async function renderDrawingParagraph(
  paragraph: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const text = drawingParagraphText(paragraph);
  if (text.length === 0) return;
  await xhtml.startElement("p");
  await xhtml.characters(text);
  await xhtml.endElement("p");
}

function drawingParagraphText(node: XmlNode): string {
  let text = "";
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      const name = localName(child.name);
      if (name === "t") text += child.text;
      else if (name === "br") text += "\n";
      else if (name === "tab") text += "\t";
      else visit(child);
    }
  };
  visit(node);
  return text;
}

async function renderDrawingTable(
  table: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  await xhtml.startElement("table");
  for (const row of childrenNamed(table, "tr")) {
    await xhtml.startElement("tr");
    for (const cell of childrenNamed(row, "tc")) {
      await xhtml.startElement("td");
      await renderDrawingBlocks(cell, xhtml);
      await xhtml.endElement("td");
    }
    await xhtml.endElement("tr");
  }
  await xhtml.endElement("table");
}

// ---------------------------------------------------------------------------
// Embedded parts: charts, OLE objects and media
// ---------------------------------------------------------------------------

const CHART_PART = /^(word|xl|ppt)\/charts\/chart\d+\.xml$/;
const DIAGRAM_PART = /^(word|ppt)\/diagrams\/data\d+\.xml$/;
const EMBEDDED_PART = /^(word|xl|ppt)\/embeddings\/([^/]+)$/;
const MEDIA_PART = /^(word|xl|ppt)\/media\/([^/]+)$/;

async function renderEmbeddedParts(
  files: Record<string, Uint8Array>,
  xhtml: XHTMLContentHandler,
  ctx: ParseContext,
): Promise<void> {
  for (const name of Object.keys(files).sort()) {
    if (DIAGRAM_PART.test(name)) {
      await xhtml.startElement("div", "class", "diagram");
      await renderDiagram(files[name]!, xhtml);
      await xhtml.endElement("div");
      continue;
    }
    if (CHART_PART.test(name)) {
      await xhtml.startElement("div", "class", "chart");
      await renderChart(files[name]!, xhtml);
      await xhtml.endElement("div");
      continue;
    }
    const embedded = EMBEDDED_PART.exec(name) ?? MEDIA_PART.exec(name);
    if (embedded === null) continue;
    const bytes = files[name]!;
    await xhtml.startElement("div", "class", "embedded");
    await xhtml.element("h1", embedded[2] ?? name);
    await parseEmbeddedPart(xhtml, embedded[2] ?? name, bytes, ctx);
    await xhtml.endElement("div");
  }
}

async function parseEmbeddedPart(
  handler: XHTMLContentHandler,
  name: string,
  bytes: Uint8Array,
  ctx: ParseContext,
): Promise<void> {
  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as
      | EmbeddedDocumentExtractor
      | undefined) ?? undefined;
  if (extractor === undefined) return;
  const metadata = new Metadata();
  metadata.set("resourceName", name);
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    await extractor.parseEmbedded(stream, handler, metadata, ctx);
  } catch {
    // Unsupported embedded formats are recorded but must not fail the package.
  } finally {
    await stream.close();
  }
}

async function renderDiagram(
  bytes: Uint8Array,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const root = parseXmlTree(decode(bytes));
  const texts = descendantsNamed(root, "t")
    .map((node) => node.text.trim())
    .filter((value) => value.length > 0);
  for (const text of texts) await xhtml.element("p", text);
}

async function renderChart(
  bytes: Uint8Array,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  const root = parseXmlTree(decode(bytes));
  const title = findFirst(root, "title");
  if (title !== undefined) {
    const text = descendantsNamed(title, "t")
      .map((node) => node.text)
      .join("")
      .trim();
    if (text.length > 0) await xhtml.element("h1", text);
  }

  for (const series of descendantsNamed(root, "ser")) {
    const name = chartText(findFirst(series, "tx"));
    const categories = chartValues(findFirst(series, "cat"));
    const values = chartValues(findFirst(series, "val"));
    const parts: string[] = [];
    if (name.length > 0) parts.push(name);
    if (categories.length > 0) {
      parts.push(`categories: ${categories.join(", ")}`);
    }
    if (values.length > 0) parts.push(`values: ${values.join(", ")}`);
    if (parts.length > 0) await xhtml.element("p", parts.join("; "));
  }
}

function chartText(node: XmlNode | undefined): string {
  if (node === undefined) return "";
  return descendantsNamed(node, "v")
    .concat(descendantsNamed(node, "t"))
    .map((child) => child.text)
    .join("")
    .trim();
}

function chartValues(node: XmlNode | undefined): string[] {
  if (node === undefined) return [];
  const values = descendantsNamed(node, "v").map((child) => child.text.trim());
  return values.filter((value) => value.length > 0);
}

// ---------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------

function parsePart(
  files: Record<string, Uint8Array>,
  name: string,
): XmlNode | undefined {
  const data = files[name];
  return data === undefined ? undefined : parseXmlTree(decode(data));
}

function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  return descendantsNamed(node, name)[0];
}

function applyPackageMetadata(
  metadata: Metadata,
  files: Record<string, Uint8Array>,
): void {
  const core = files["docProps/core.xml"];
  if (core !== undefined) {
    const values = propertyMap(decode(core));
    assign(metadata, "dc:title", values.title);
    assign(metadata, "dc:creator", values.creator);
    assign(metadata, "dc:description", values.subject ?? values.description);
    assign(metadata, "pdf:Keywords", values.keywords);
    assign(metadata, "dcterms:created", values.created);
    assign(metadata, "dcterms:modified", values.modified);
    assign(metadata, "meta:last-author", values.lastModifiedBy);
    assign(metadata, "cp:revision", values.revision);
    assign(metadata, "cp:contentStatus", values.contentStatus);
    assign(metadata, "dc:language", values.language);
    assign(metadata, "dc:identifier", values.identifier);
    assign(metadata, "cp:category", values.category);
  }

  const custom = files["docProps/custom.xml"];
  if (custom !== undefined) {
    const root = parseXmlTree(decode(custom));
    for (const property of descendantsNamed(root, "property")) {
      const name = attribute(property, "name");
      if (name === undefined || name.length === 0) continue;
      const value = property.children
        .map((child) => child.text)
        .join("")
        .trim();
      if (value.length > 0) metadata.add(`custom:${name}`, value);
    }
  }

  const app = files["docProps/app.xml"];
  if (app !== undefined) {
    const values = propertyMap(decode(app));
    assign(metadata, "extended-properties:Application", values.Application);
    assign(metadata, "extended-properties:Company", values.Company);
    assign(metadata, "extended-properties:Pages", values.Pages);
    assign(metadata, "extended-properties:Words", values.Words);
    assign(metadata, "extended-properties:Characters", values.Characters);
    assign(metadata, "extended-properties:Slides", values.Slides);
  }
}

function propertyMap(xml: string): Record<string, string> {
  const values: Record<string, string> = {};
  const visit = (node: XmlNode): void => {
    for (const child of node.children) {
      const name = localName(child.name);
      if (child.children.length === 0) {
        values[name] = child.text;
      } else {
        visit(child);
      }
    }
  };
  visit(parseXmlTree(xml));
  return values;
}

function assign(metadata: Metadata, key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) metadata.set(key, value);
}
