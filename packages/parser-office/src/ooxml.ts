import {
  CONTEXT_KEYS,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParseTimeoutError,
  AbortError,
  UnsupportedFormatError,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type EmbeddedDocumentExtractor,
  type Parser,
  RipstreamInputStream,
  TIKA_KEYS,
} from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";
import { OpcPackage } from "./opc.ts";
import {
  attribute,
  childrenNamed,
  descendantsNamed,
  localName,
  MAX_XML_DEPTH,
  parseXmlTree,
  type XmlNode,
} from "./xml-tree.ts";
import { formatExcelDate, formatExcelDateCode, isDateFormat } from "./excel-format.ts";

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

    await renderEmbeddedParts(files, xhtml, metadata, ctx);
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
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments|glossary\/document)\.xml$|^word\/(charts\/chart\d+\.xml|diagrams\/data\d+\.xml|embeddings\/[^/]+|media\/[^/]+)$/;
const XLSX_PARTS =
  /^xl\/(workbook|sharedStrings|styles)\.xml$|^xl\/(worksheets\/sheet\d+\.xml|charts\/chart\d+\.xml|drawings\/drawing\d+\.xml|embeddings\/[^/]+|media\/[^/]+)$/i;
const PPTX_PARTS =
  /^ppt\/(presentation)\.xml$|^ppt\/(slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml|charts\/chart\d+\.xml|diagrams\/data\d+\.xml|embeddings\/[^/]+|media\/[^/]+)$/;

// The relationships of any part under word/, xl/ or ppt/: they say what each embedded part is (see embeddedTypesByPart).
const RELATIONSHIP_PARTS = /^(?:word|xl|ppt)\/(?:.+\/)?_rels\/[^/]+\.rels$/;

function neededPart(name: string): boolean {
  if (SHARED_PARTS.test(name) || RELATIONSHIP_PARTS.test(name)) return true;
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
  // A glossary building block's body holds the content-control text Tika extracts from the glossary part.
  const glossary = parsePart(files, "word/glossary/document.xml");
  if (glossary !== undefined) {
    for (const body of descendantsNamed(glossary, "docPartBody")) await renderWordBlocks(body, xhtml);
  }
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

/** A row's cells, looking through the content-control wrappers a cell may sit in. */
function rowCells(row: XmlNode): XmlNode[] {
  const cells: XmlNode[] = [];
  const visit = (node: XmlNode): void => {
    for (const child of node.children) {
      const name = localName(child.name);
      if (name === "tc") cells.push(child);
      else if (name === "sdt" || name === "sdtContent" || name === "customXml") visit(child);
    }
  };
  visit(row);
  return cells;
}

async function renderWordTable(
  table: XmlNode,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  await xhtml.startElement("table");
  for (const row of childrenNamed(table, "tr")) {
    await xhtml.startElement("tr");
    for (const cell of rowCells(row)) {
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
  /** The number format code of each cell style, builtin codes included, or null for General. */
  readonly codes: (string | null)[];
}

/** Builtin number formats (ECMA-376 18.8.30), the subset whose display differs from the raw value. */
const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
  9: "0%", 10: "0.00%", 11: "0.00E+00", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 48: "##0.0E+0", 49: "@",
};

function parseStyles(xml: string | undefined): Styles {
  const dateStyles: boolean[] = [];
  const percentStyles: boolean[] = [];
  const decimals: number[] = [];
  const codes: (string | null)[] = [];
  if (xml === undefined) return { dateStyles, percentStyles, decimals, codes };

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
    codes.push(code ?? BUILTIN_FORMATS[id] ?? null);
  }
  return { dateStyles, percentStyles, decimals, codes };
}

/**
 * Reads the rows of a worksheet while the XML is being parsed, so the caps below fire at the cap and the tree of a
 * whole sheet is never built (tikajs-kpkn: a 4M-cell sheet cost 2-3 GB before the cell cap was reached). Only one
 * cell's subtree is held at a time. A `row` is any element so named that is not inside another row, and a cell is a
 * `c` that is a direct child of it; character data is `text` events only, as parseXmlTree reads it.
 */
interface ParsedSheet {
  readonly rows: SheetRow[];
  /** `oddHeader`/`oddFooter`/... text, raw `&` codes included, as Tika's sheet handler emits it. */
  readonly headerFooter: string[];
}

const HEADER_FOOTER_ELEMENTS: ReadonlySet<string> = new Set([
  "oddHeader", "evenHeader", "firstHeader", "oddFooter", "evenFooter", "firstFooter",
]);

function parseSheet(xml: string, shared: string[]): ParsedSheet {
  const rows: SheetRow[] = [];
  const headerFooter: string[] = [];
  let captureDepth = 0;
  let captured = "";
  let row: SheetCell[] = [];
  let nextColumn = 0;
  let totalCells = 0;

  let depth = 0;
  let rowDepth = 0; // depth of the open row element, 0 when none
  let cellStack: XmlNode[] = []; // the open cell element and its open descendants, empty outside a cell

  const finishCell = (cellNode: XmlNode): void => {
    const reference = attribute(cellNode, "r");
    const column = reference === undefined ? nextColumn : columnIndex(reference);

    const cellType = attribute(cellNode, "t") ?? "";
    const styleIndex = Number(attribute(cellNode, "s") ?? "0");
    let text = "";
    let inInline = false;
    let hasValue = false;

    const visit = (node: XmlNode): void => {
      for (const child of node.children) {
        const name = localName(child.name);
        if (name === "v") {
          hasValue = true;
          text += child.text;
        } else if (name === "is") {
          hasValue = true;
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

    // Tika's TikaSheetXMLHandler writes a cell when its <v> or <is> ends, so a styled cell with no value (the cells
    // of a merged region) writes nothing; the empty cells in front of the next value cell are padding.
    if (!hasValue) return;

    totalCells += column + 1 - nextColumn;
    if (totalCells > MAX_SHEET_CELLS) {
      throw new LimitExceededError(`Sheet exceeds ${MAX_SHEET_CELLS} cells`);
    }
    while (nextColumn < column) {
      row.push({ value: "", styleIndex: 0, type: "" });
      nextColumn++;
    }

    row.push({
      value: cellType === "s" ? (shared[Number(text)] ?? "") : text,
      styleIndex,
      type: cellType,
    });
    nextColumn = column + 1;
  };

  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    depth++;
    if (depth > MAX_XML_DEPTH) {
      throw new MalformedDocumentError(`XML nesting exceeds ${MAX_XML_DEPTH} levels`);
    }
    const name = localName(tag.name);
    if (HEADER_FOOTER_ELEMENTS.has(name)) {
      captureDepth = depth;
      captured = "";
    }
    const node: XmlNode = {
      name: tag.name,
      attributes: { ...(tag.attributes as Record<string, string>) },
      children: [],
      text: "",
    };
    if (cellStack.length > 0) {
      cellStack[cellStack.length - 1]!.children.push(node);
      cellStack.push(node);
    } else if (rowDepth === 0 && name === "row") {
      rowDepth = depth;
      row = [];
      nextColumn = 0;
    } else if (rowDepth !== 0 && depth === rowDepth + 1 && name === "c") {
      cellStack.push(node);
    }
  });
  parser.on("text", (text) => {
    if (captureDepth !== 0) captured += text;
    if (cellStack.length > 0) cellStack[cellStack.length - 1]!.text += text;
  });
  parser.on("closetag", () => {
    if (captureDepth !== 0 && captureDepth === depth) {
      headerFooter.push(captured);
      captureDepth = 0;
    }
    if (cellStack.length > 0) {
      const closed = cellStack.pop()!;
      if (cellStack.length === 0) finishCell(closed);
    } else if (depth === rowDepth) {
      // An empty row has no cells, so the cell cap does not bound it; the row cap does.
      if (rows.length >= MAX_SHEET_ROWS) {
        throw new LimitExceededError(`Sheet exceeds ${MAX_SHEET_ROWS} rows`);
      }
      rows.push({ cells: row });
      rowDepth = 0;
    }
    depth--;
  });
  parser.write(xml).close();
  return { rows, headerFooter };
}

const MAX_COLUMNS = 16_384;
/** Cap on materialized (real plus padding) cells per sheet. */
const MAX_SHEET_CELLS = 1_000_000;
/** Cap on rows per sheet: Excel's own limit, 2^20. */
const MAX_SHEET_ROWS = 1_048_576;

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
  const code = styles.codes[cell.styleIndex];
  if (styles.dateStyles[cell.styleIndex] === true) {
    return code === null || code === undefined ? formatExcelDate(number) : formatExcelDateCode(code, number);
  }
  // POI's General format writes the numeric cell value, not the text stored in the file.
  return code === null || code === undefined ? String(number) : formatNumber(code, number);
}

/**
 * A display value for a cell's number format code, as POI's DataFormatter writes it. Covers the common case: a
 * positive/negative/zero section, thousands separators, fixed decimals, a percent sign, and quoted or currency
 * literals around the digits; anything else falls back to the raw value.
 */
function formatNumber(code: string, value: number): string {
  const sections = code.split(";");
  const section = sections[value < 0 ? 1 : value === 0 ? 2 : 0] ?? sections[0]!;
  const percent = section.includes("%");
  const decimals = /\.(0+)/.exec(section)?.[1]?.length ?? 0;
  const grouping = /[#0],[#0]/.test(section);
  const magnitude = Math.abs(value) * (percent ? 100 : 1);
  let digits = magnitude.toFixed(decimals);
  if (grouping) {
    const [whole = "", fraction] = digits.split(".");
    digits = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
  }
  const [prefix, suffix] = numberAffixes(section);
  const negative = value < 0 && sections.length < 2 ? "-" : "";
  return `${negative}${prefix}${digits}${percent ? "%" : ""}${suffix}`;
}

/** Literal text before and after the digit placeholders: quoted text, escaped characters and currency symbols. */
function numberAffixes(section: string): [string, string] {
  const literal = (part: string): string => {
    let text = "";
    for (let index = 0; index < part.length; index++) {
      const char = part[index]!;
      if (char === '"') {
        const end = part.indexOf('"', index + 1);
        if (end < 0) break;
        text += part.slice(index + 1, end);
        index = end;
      } else if (char === "\\" && index + 1 < part.length) {
        text += part[++index]!;
      } else if (char === "_" || char === "*") {
        index++;
      } else if (char === "[") {
        const end = part.indexOf("]", index + 1);
        index = end < 0 ? part.length : end;
      } else if (!"#0.,%?/Ee+".includes(char)) {
        text += char;
      }
    }
    return text;
  };
  const first = section.search(/[#0]/);
  const last = section.search(/[#0](?!.*[#0])/);
  if (first < 0) return ["", ""];
  return [literal(section.slice(0, first)), literal(section.slice(last + 1))];
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
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b));

  for (let index = 0; index < sheetFiles.length; index++) {
    const name = names[index];
    await xhtml.startElement("div", "class", "sheet");
    if (name !== undefined) {
      await xhtml.startElement("h1");
      await xhtml.characters(name);
      await xhtml.endElement("h1");
    }
    const { rows, headerFooter } = parseSheet(decode(files[sheetFiles[index]!]!), shared);
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
    for (const text of headerFooter) if (text.length > 0) await xhtml.element("p", text);
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
    for (const cell of rowCells(row)) {
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
/** Text boxes in a spreadsheet live in the sheet's drawing part (`a:t` runs). */
const XLSX_DRAWING_PART = /^xl\/drawings\/drawing\d+\.xml$/;
const DIAGRAM_PART = /^(word|ppt)\/diagrams\/data\d+\.xml$/;
const EMBEDDED_PART = /^(word|xl|ppt)\/embeddings\/([^/]+)$/;
const MEDIA_PART = /^(word|xl|ppt)\/media\/([^/]+)$/;

const OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * The `tk:embedded-resource-type` Tika's AbstractOOXMLExtractor gives a part by the type of the relationship that
 * reaches it: an image is INLINE; audio, video, media, package and oleObject are ATTACHMENT.
 */
const EMBEDDED_TYPE_OF_RELATIONSHIP: ReadonlyMap<string, string> = new Map([
  [`${OFFICE_RELATIONSHIPS}/image`, "INLINE"],
  [`${OFFICE_RELATIONSHIPS}/audio`, "ATTACHMENT"],
  [`${OFFICE_RELATIONSHIPS}/video`, "ATTACHMENT"],
  ["http://schemas.microsoft.com/office/2007/relationships/media", "ATTACHMENT"],
  [`${OFFICE_RELATIONSHIPS}/package`, "ATTACHMENT"],
  [`${OFFICE_RELATIONSHIPS}/oleObject`, "ATTACHMENT"],
]);

/**
 * The type of each part an internal relationship of a known type points to, by part name. A part reached by two
 * relationships of different types takes the one in the first relationships file by name: Tika's order is POI's, which
 * is not reproduced. A relationships file that cannot be read types nothing; the parts are still extracted.
 */
function embeddedTypesByPart(files: Record<string, Uint8Array>): Map<string, string> {
  const types = new Map<string, string>();
  for (const name of Object.keys(files).sort()) {
    if (!RELATIONSHIP_PARTS.test(name)) continue;
    const sourceFolder = name.slice(0, name.lastIndexOf("/_rels/"));
    let relationships: XmlNode[];
    try {
      relationships = descendantsNamed(parseXmlTree(decode(files[name]!)), "Relationship");
    } catch {
      continue;
    }
    for (const relationship of relationships) {
      const type = EMBEDDED_TYPE_OF_RELATIONSHIP.get(attribute(relationship, "Type") ?? "");
      const target = attribute(relationship, "Target");
      if (type === undefined || target === undefined) continue;
      if (attribute(relationship, "TargetMode") === "External") continue;
      const part = resolveTarget(sourceFolder, target);
      if (!types.has(part)) types.set(part, type);
    }
  }
  return types;
}

/** A relationship target as a part name: absolute from the package root, else from the source part's folder. */
function resolveTarget(sourceFolder: string, target: string): string {
  let path = target;
  try {
    path = decodeURIComponent(target);
  } catch {
    // A target that is not valid percent-encoding is read as written.
  }
  const segments = path.startsWith("/") ? [] : sourceFolder.split("/");
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "." && segment !== "") segments.push(segment);
  }
  return segments.join("/");
}

async function renderEmbeddedParts(
  files: Record<string, Uint8Array>,
  xhtml: XHTMLContentHandler,
  parentMetadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  const types = embeddedTypesByPart(files);
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
    if (XLSX_DRAWING_PART.test(name)) {
      await xhtml.startElement("div", "class", "drawing");
      const drawing = parsePart(files, name);
      if (drawing !== undefined) {
        for (const text of descendantsNamed(drawing, "t")) {
          if (text.text.length > 0) await xhtml.element("p", text.text);
        }
      }
      await xhtml.endElement("div");
      continue;
    }
    const embedded = EMBEDDED_PART.exec(name) ?? MEDIA_PART.exec(name);
    if (embedded === null) continue;
    const bytes = files[name]!;
    await xhtml.startElement("div", "class", "embedded");
    await xhtml.element("h1", embedded[2] ?? name);
    await parseEmbeddedPart(xhtml, embedded[2] ?? name, bytes, parentMetadata, ctx, types.get(name));
    await xhtml.endElement("div");
  }
}

async function parseEmbeddedPart(
  handler: XHTMLContentHandler,
  name: string,
  bytes: Uint8Array,
  parentMetadata: Metadata,
  ctx: ParseContext,
  type: string | undefined,
): Promise<void> {
  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as
      | EmbeddedDocumentExtractor
      | undefined) ?? undefined;
  if (extractor === undefined) return;
  const metadata = new Metadata();
  metadata.set("tk:resource-name", name);
  if (type !== undefined) metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE, type);
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    await extractor.parseEmbedded(stream, handler, metadata, ctx);
  } catch (error) {
    // Resiliency errors must reach the server (422/408) instead of a truncated 200.
    if (
      error instanceof LimitExceededError ||
      error instanceof ParseTimeoutError ||
      error instanceof AbortError ||
      ctx.signal.aborted
    ) {
      throw error;
    }
    // An embedded part that fails must not fail the package; its exception goes on the package's metadata, as Tika's
    // CompositeParser records each failed child.
    parentMetadata.add(
      TIKA_KEYS.EMBEDDED_EXCEPTION,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
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
    applyExtendedProperties(metadata, propertyMap(decode(app)));
  }
}

/**
 * docProps/app.xml, written under the keys Tika writes (SAXBasedMetadataExtractor.ExtendedPropertiesHandler.applyTo):
 * a text property when it is not blank, an integer property only when it is a positive int, xmpTPg:NPages from Pages
 * and, when there are none, from Slides, and the doc-security string for every flag.
 */
function applyExtendedProperties(metadata: Metadata, values: Record<string, string>): void {
  const text = (name: string): string | undefined => {
    const value = values[name]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  };
  const positive = (name: string): number => {
    const value = text(name);
    // Tika's safeParseInt reads a non-number, a negative and anything over Integer.MAX_VALUE as 0.
    if (value === undefined || !/^[+-]?\d+$/.test(value)) return 0;
    const number = Number(value);
    return number <= 2_147_483_647 ? Math.max(number, 0) : 0;
  };
  const setPositive = (key: string, name: string): void => {
    const value = positive(name);
    if (value > 0) metadata.set(key, String(value));
  };

  assign(metadata, "extended-properties:Application", text("Application"));
  assign(metadata, "extended-properties:AppVersion", text("AppVersion"));
  assign(metadata, "dc:publisher", text("Company"));
  assign(metadata, "extended-properties:Company", text("Company"));
  const manager = text("Manager");
  if (manager !== undefined) {
    for (const part of new Set(manager.split(";"))) {
      if (part.trim().length > 0) metadata.add("extended-properties:Manager", part);
    }
  }
  assign(metadata, "extended-properties:Notes", text("Notes"));
  assign(metadata, "extended-properties:PresentationFormat", text("PresentationFormat"));
  assign(metadata, "extended-properties:Template", text("Template"));
  setPositive("extended-properties:TotalTime", "TotalTime");
  setPositive("extended-properties:DocSecurity", "DocSecurity");
  metadata.set("extended-properties:doc-security-string", docSecurityString(positive("DocSecurity")));

  const pages = positive("Pages");
  const slides = positive("Slides");
  if (pages > 0) metadata.set("xmpTPg:NPages", String(pages));
  else if (slides > 0) metadata.set("xmpTPg:NPages", String(slides));
  setPositive("meta:page-count", "Pages");
  setPositive("meta:slide-count", "Slides");
  setPositive("meta:paragraph-count", "Paragraphs");
  setPositive("meta:line-count", "Lines");
  setPositive("meta:word-count", "Words");
  setPositive("meta:character-count", "Characters");
  setPositive("meta:character-count-with-spaces", "CharactersWithSpaces");
}

function docSecurityString(flag: number): string {
  switch (flag) {
    case 0:
      return "None";
    case 1:
      return "PasswordProtected";
    case 2:
      return "ReadOnlyRecommended";
    case 4:
      return "ReadOnlyEnforced";
    case 8:
      return "LockedForAnnotations";
    default:
      return "Unknown";
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
