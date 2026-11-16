/**
 * The block structure of a Markdown document: paragraphs, headings, lists, block quotes, code, HTML blocks, thematic
 * breaks and GFM pipe tables, as CommonMark and GFM draw them, so that the parser can write the elements Tika's does
 * (`ul`/`li`, `table`/`tr`/`td`, ...) and the XHTML handler can lay the text out as it does for Tika.
 *
 * It is a line-based reading of the spec, not a port of a reference parser: it knows what the documents it meets use
 * (container blocks, tight and loose lists, lazy continuation, setext headings, fenced code). It is linear in the input:
 * every line is looked at a bounded number of times for each level of nesting, and nesting stops at MAX_DEPTH, below
 * which a quote or list marker is plain text.
 */

/** Containers (quotes, list items) nest no deeper than this; deeper markers are text. */
export const MAX_DEPTH = 32;

export interface SourceLine {
  readonly text: string;
  /** 1-based line of the source. */
  readonly no: number;
  /** The line is not indented to its container's content and goes on a paragraph only (a lazy continuation line). */
  readonly lazy?: boolean;
  /**
   * The line as written, from where `text` starts, when the two differ (there is a tab in the indentation): code keeps the
   * tabs it holds. `rawColumn` is the column the written text starts at, which the width of a tab depends on.
   */
  readonly raw?: string;
  readonly rawColumn?: number;
  /** Columns of a tab that a container took part of: they are spaces at the start of `raw` that indentation of a fence cannot take off. */
  readonly rawPad?: number;
}

interface BlockBase {
  /** The source line the block starts on. */
  readonly line: number;
  /** A blank line follows the block and a block of the same container follows that. */
  blankAfter?: boolean;
}

export interface ParagraphBlock extends BlockBase {
  readonly kind: "paragraph";
  readonly lines: readonly string[];
}

export interface HeadingBlock extends BlockBase {
  readonly kind: "heading";
  readonly level: number;
  readonly lines: readonly string[];
  /** Text that is not a heading to a reader: the lines between two `---` at the start of a document (front matter). */
  readonly frontMatter: boolean;
}

export interface CodeBlock extends BlockBase {
  readonly kind: "code";
  readonly lines: readonly string[];
}

export interface HtmlBlock extends BlockBase {
  readonly kind: "html";
  readonly lines: readonly string[];
}

export interface RuleBlock extends BlockBase {
  readonly kind: "rule";
}

export interface QuoteBlock extends BlockBase {
  readonly kind: "quote";
  readonly children: readonly Block[];
}

export interface ListItem {
  readonly line: number;
  readonly children: readonly Block[];
}

export interface ListBlock extends BlockBase {
  readonly kind: "list";
  readonly ordered: boolean;
  /** No blank line between its items or between the blocks of one item: the paragraphs of its items are not wrapped. */
  readonly tight: boolean;
  readonly items: readonly ListItem[];
}

export interface TableBlock extends BlockBase {
  readonly kind: "table";
  readonly header: readonly string[];
  /** Every row has as many cells as the header: short rows are padded and long ones cut, as GFM has it. */
  readonly rows: readonly (readonly string[])[];
}

export type Block = ParagraphBlock | HeadingBlock | CodeBlock | HtmlBlock | RuleBlock | QuoteBlock | ListBlock | TableBlock;

export function parseMarkdownBlocks(markdown: string, definitions: Map<string, string> = new Map()): Block[] {
  const lines: SourceLine[] = [];
  let no = 1;
  const split = markdown.split(/\r\n|\r|\n/);
  // The last line ending ends a line, it does not start an empty one.
  if (split.length > 1 && split[split.length - 1] === "") split.pop();
  for (const text of split) {
    const expanded = expandIndent(text);
    lines.push(expanded === text ? { text, no: no++ } : { text: expanded, no: no++, raw: text, rawColumn: 0 });
  }
  return parseBlocks(lines, 0, definitions);
}

/** Tabs in the indentation count to the next multiple of four columns, as the spec has it; later tabs are text. */
function expandIndent(text: string): string {
  let end = 0;
  while (end < text.length && (text.charCodeAt(end) === 0x20 || text.charCodeAt(end) === 0x09)) end++;
  if (end === 0 || text.indexOf("\t") === -1 || text.indexOf("\t") >= end) return text;
  let column = 0;
  for (let index = 0; index < end; index++) column += text.charCodeAt(index) === 0x09 ? 4 - (column % 4) : 1;
  return " ".repeat(column) + text.slice(end);
}

/** `raw` without its first `columns` columns, which start at `column`; a tab that is cut in two leaves its second part as `pad` columns. */
function advanceRaw(line: SourceLine, columns: number): { readonly raw: string; readonly column: number; readonly pad: number } {
  const raw = line.raw!;
  let column = line.rawColumn ?? 0;
  let pad = line.rawPad ?? 0;
  let left = columns;
  const used = Math.min(pad, left);
  pad -= used;
  left -= used;
  const target = column + left;
  let index = 0;
  while (index < raw.length && column < target) {
    if (raw.charCodeAt(index) === 0x09) {
      const width = 4 - (column % 4);
      if (column + width > target) return { raw: raw.slice(index + 1), column: target, pad: column + width - target };
      column += width;
    } else {
      column++;
    }
    index++;
  }
  return { raw: raw.slice(index), column, pad };
}

/** The line with `columns` columns off its front, as a container takes its marker or indentation off the lines it holds. */
function dropColumns(line: SourceLine, columns: number, lazy = false): SourceLine {
  const text = line.text.slice(columns);
  const base: SourceLine = lazy ? { text, no: line.no, lazy } : { text, no: line.no };
  if (line.raw === undefined) return base;
  const { raw, column, pad } = advanceRaw(line, columns);
  return { ...base, raw, rawColumn: column, rawPad: pad };
}

/** The text of a line of indented code with `columns` columns of indentation off: from the line as written when it has one, so that a tab inside the code stays a tab. */
function stripColumns(line: SourceLine, columns: number): string {
  if (line.raw === undefined) return line.text.slice(columns);
  const { raw, pad } = advanceRaw(line, columns);
  return " ".repeat(pad) + raw;
}

/** The text of a line of fenced code: the fence's indentation is taken off as far as it is spaces, a tab is kept as it is. */
function stripFenceIndent(line: SourceLine, indent: number): string {
  if (line.raw === undefined) return line.text.slice(Math.min(indent, indentOf(line.text)));
  const pad = line.rawPad ?? 0;
  let strip = 0;
  if (pad === 0) while (strip < indent && line.raw.charCodeAt(strip) === 0x20) strip++;
  return " ".repeat(pad) + line.raw.slice(strip);
}

/** `text` without the spaces and tabs at its start and its end (as asked): they are the ones CommonMark takes off a line, a no-break space is text. */
export function trimSpaces(text: string, start = true, end = true): string {
  let from = 0;
  let to = text.length;
  if (start) while (from < to && (text.charCodeAt(from) === 0x20 || text.charCodeAt(from) === 0x09)) from++;
  if (end) while (to > from && (text.charCodeAt(to - 1) === 0x20 || text.charCodeAt(to - 1) === 0x09)) to--;
  return text.slice(from, to);
}

function indentOf(text: string): number {
  let index = 0;
  while (index < text.length && text.charCodeAt(index) === 0x20) index++;
  return index;
}

function isBlank(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09) return false;
  }
  return true;
}

function parseBlocks(lines: readonly SourceLine[], depth: number, definitions: Map<string, string>): Block[] {
  const out: Block[] = [];
  const count = lines.length;
  let index = 0;
  while (index < count) {
    const line = lines[index]!;
    const text = line.text;
    if (isBlank(text)) {
      const last = out[out.length - 1];
      if (last !== undefined) last.blankAfter = true;
      index++;
      continue;
    }
    const indent = indentOf(text);
    const rest = text.slice(indent);

    if (indent >= 4) {
      index = readIndentedCode(lines, index, out);
      continue;
    }
    const fence = fenceOpen(rest);
    if (fence !== undefined) {
      index = readFence(lines, index, indent, fence, out);
      continue;
    }
    if (isAtxHeading(rest)) {
      out.push({ kind: "heading", line: line.no, level: atxLevel(rest), lines: [atxText(rest)], frontMatter: false });
      index++;
      continue;
    }
    if (isRule(rest)) {
      out.push({ kind: "rule", line: line.no });
      index++;
      continue;
    }
    if (depth < MAX_DEPTH && rest.charCodeAt(0) === 0x3e) {
      index = readQuote(lines, index, depth, out, definitions);
      continue;
    }
    if (depth < MAX_DEPTH && listMarker(rest) !== undefined) {
      index = readList(lines, index, depth, out, definitions);
      continue;
    }
    const html = htmlStart(rest, false);
    if (html !== undefined) {
      index = readHtml(lines, index, html, out);
      continue;
    }
    if (tableStartsAt(lines, index)) {
      index = readTable(lines, index, depth, out);
      continue;
    }
    index = readParagraph(lines, index, depth, out, definitions);
  }
  return out;
}

// --- leaf blocks ---------------------------------------------------------------------------------------------------

function readIndentedCode(lines: readonly SourceLine[], start: number, out: Block[]): number {
  const code: string[] = [];
  let index = start;
  let end = start;
  for (; index < lines.length; index++) {
    const text = lines[index]!.text;
    if (isBlank(text)) {
      code.push(text.slice(Math.min(4, text.length)));
      continue;
    }
    if (indentOf(text) < 4) break;
    code.push(stripColumns(lines[index]!, 4));
    end = index;
  }
  code.length = end - start + 1;
  out.push({ kind: "code", line: lines[start]!.no, lines: code });
  return end + 1;
}

interface Fence {
  readonly char: string;
  readonly length: number;
}

function fenceOpen(rest: string): Fence | undefined {
  const char = rest[0];
  if (char !== "`" && char !== "~") return undefined;
  let length = 0;
  while (rest[length] === char) length++;
  if (length < 3) return undefined;
  if (char === "`" && rest.indexOf("`", length) !== -1) return undefined;
  return { char, length };
}

function isFenceClose(text: string, fence: Fence): boolean {
  const indent = indentOf(text);
  if (indent >= 4) return false;
  let index = indent;
  while (text[index] === fence.char) index++;
  return index - indent >= fence.length && isBlank(text.slice(index));
}

function readFence(lines: readonly SourceLine[], start: number, indent: number, fence: Fence, out: Block[]): number {
  const code: string[] = [];
  let index = start + 1;
  for (; index < lines.length; index++) {
    const text = lines[index]!.text;
    if (isFenceClose(text, fence)) {
      index++;
      break;
    }
    code.push(stripFenceIndent(lines[index]!, indent));
  }
  // The code's text starts on the line after the fence, and that is the line it is located by.
  out.push({ kind: "code", line: lines[start]!.no + 1, lines: code });
  return index;
}

function isAtxHeading(rest: string): boolean {
  let hashes = 0;
  while (rest.charCodeAt(hashes) === 0x23) hashes++;
  if (hashes < 1 || hashes > 6) return false;
  return hashes === rest.length || rest.charCodeAt(hashes) === 0x20 || rest.charCodeAt(hashes) === 0x09;
}

function atxLevel(rest: string): number {
  let hashes = 0;
  while (rest.charCodeAt(hashes) === 0x23) hashes++;
  return hashes;
}

function atxText(rest: string): string {
  let text = trimSpaces(rest.slice(atxLevel(rest)));
  // A closing run of # is part of the marker when a space (or the start) comes before it.
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x23) end--;
  if (end < text.length && (end === 0 || text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) {
    text = trimSpaces(text.slice(0, end), false);
  }
  return text;
}

/** `***`, `---` or `___`, three or more, with spaces between allowed. */
function isRule(rest: string): boolean {
  const marker = rest[0];
  if (marker !== "*" && marker !== "-" && marker !== "_") return false;
  let marks = 0;
  for (let index = 0; index < rest.length; index++) {
    const char = rest[index];
    if (char === marker) marks++;
    else if (char !== " " && char !== "\t") return false;
  }
  return marks >= 3;
}

/** `===` or `---` under a paragraph: the level of the heading it makes, else 0. */
function setextLevel(rest: string): number {
  const marker = rest[0];
  if (marker !== "=" && marker !== "-") return 0;
  let index = 0;
  while (rest[index] === marker) index++;
  return isBlank(rest.slice(index)) ? (marker === "=" ? 1 : 2) : 0;
}

/** Whether the line, at a block's start, begins a block of its own rather than text. */
function startsBlockLine(lines: readonly SourceLine[], index: number, depth: number): boolean {
  const text = lines[index]!.text;
  const indent = indentOf(text);
  if (indent >= 4) return true;
  const rest = text.slice(indent);
  if (fenceOpen(rest) !== undefined || isAtxHeading(rest) || isRule(rest)) return true;
  if (depth < MAX_DEPTH && (rest.charCodeAt(0) === 0x3e || listMarker(rest) !== undefined)) return true;
  return htmlStart(rest, false) !== undefined || tableStartsAt(lines, index);
}

interface Definition {
  /** The label as a definition is looked up by: whitespace collapsed and case-folded. */
  readonly label: string;
  readonly destination: string;
  /** The line after the definition (0-based). */
  readonly next: number;
}

/**
 * The link reference definition the line starts, as CommonMark has it (`[label]: destination "title"`; the destination
 * and the title may each be on the next line), or undefined. The label's whitespace is collapsed and it is case-folded
 * for the lookup. Tika 4.2.0 drops the definitions and resolves the links that use them (tikajs-ow96).
 */
function readDefinition(lines: readonly SourceLine[], start: number): Definition | undefined {
  const first = lines[start]!;
  if (first.lazy === true) return undefined;
  const text = trimSpaces(first.text, true, false);
  if (text.charCodeAt(0) !== 0x5b) return undefined;
  const labelEnd = findLabelEnd(text, 1);
  if (labelEnd < 0) return undefined;
  const label = text.slice(1, labelEnd);
  if (label.trim().length === 0 || label.length > 999 || text.charCodeAt(labelEnd + 1) !== 0x3a) return undefined;

  // The rest of the label's line, then the destination's line when the destination is not on the label's own line.
  let line = start;
  let rest = trimSpaces(text.slice(labelEnd + 2), true, false);
  if (rest.length === 0) {
    line++;
    const continuation = nextDefinitionLine(lines, line);
    if (continuation === undefined) return undefined;
    rest = continuation;
  }

  let destination: string;
  let remainder: string;
  if (rest.charCodeAt(0) === 0x3c) {
    const close = findUnescaped(rest, 0x3e, 1);
    if (close < 0) return undefined;
    destination = rest.slice(1, close);
    remainder = rest.slice(close + 1);
  } else {
    const bare = readBareDestination(rest);
    if (bare === undefined) return undefined;
    destination = bare.destination;
    remainder = bare.remainder;
  }
  remainder = trimSpaces(remainder, true, true);

  // A title may be on the destination's line or on the line after it, with nothing after it. One that does not parse
  // on the next line is not a title (the definition stands without one); one that does not parse on this line makes
  // the definition invalid, as its trailing text does.
  if (remainder.length === 0) {
    const candidate = nextDefinitionLine(lines, line + 1);
    if (candidate !== undefined && isTitleOpener(candidate.charCodeAt(0))) {
      const titleEnd = readTitle(candidate);
      if (titleEnd > 0 && trimSpaces(candidate.slice(titleEnd), true, true).length === 0) {
        line++;
      }
    }
  } else {
    const titleEnd = readTitle(remainder);
    if (titleEnd < 0 || trimSpaces(remainder.slice(titleEnd), true, true).length !== 0) return undefined;
  }
  return { label: normalizeLabel(label), destination, next: line + 1 };
}

/** The line's text without its indentation, if it can be a definition's continuation line: not blank and not lazy. */
function nextDefinitionLine(lines: readonly SourceLine[], index: number): string | undefined {
  const line = lines[index];
  if (line === undefined || line.lazy === true || isBlank(line.text)) return undefined;
  return trimSpaces(line.text, true, false);
}

/** Where, from `from` on, the label's closing `]` is, or -1. A label holds no unescaped bracket. */
function findLabelEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "[") return -1;
    if (char === "]") return index;
  }
  return -1;
}

/** Where, from `from` on, the first unescaped `close` is, or -1. */
function findUnescaped(text: string, close: number, from: number): number {
  for (let index = from; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char === 0x5c) {
      index++;
      continue;
    }
    if (char === close) return index;
    if (close === 0x29 && char === 0x28) return -1;
  }
  return -1;
}

/** A destination that is not in `<>`: a run of non-space with balanced parentheses, and what follows it. */
function readBareDestination(text: string): { destination: string; remainder: string } | undefined {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char === 0x5c) {
      index++;
      continue;
    }
    if (char === 0x28) depth++;
    else if (char === 0x29) {
      if (depth === 0) return undefined;
      depth--;
    } else if (char <= 0x20 || char === 0x7f) {
      if (index === 0) return undefined;
      return { destination: text.slice(0, index), remainder: text.slice(index) };
    }
  }
  if (depth !== 0 || text.length === 0) return undefined;
  return { destination: text, remainder: "" };
}

function isTitleOpener(char: number): boolean {
  return char === 0x22 || char === 0x27 || char === 0x28;
}

/** Where the title that starts the text ends (the index after its closing delimiter), or -1. */
function readTitle(text: string): number {
  const opener = text.charCodeAt(0);
  const closer = opener === 0x28 ? 0x29 : opener;
  for (let index = 1; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char === 0x5c) {
      index++;
      continue;
    }
    if (char === closer) return index + 1;
    if (closer === 0x29 && char === 0x28) return -1;
  }
  return -1;
}

/** A definition label as links are matched to it: whitespace collapsed to one space, the ends trimmed, case-folded. */
export function normalizeLabel(label: string): string {
  return label.replace(/\\([!-/:-@[-`{-~])/g, "$1").trim().replace(/\s+/g, " ").toLowerCase();
}

function readParagraph(lines: readonly SourceLine[], start: number, depth: number, out: Block[], definitions: Map<string, string>): number {
  // Link reference definitions at the start of the paragraph define links and are not text. A paragraph of definitions
  // alone writes nothing (as Tika 4.2.0 does: tikajs-ow96).
  let first = start;
  for (;;) {
    const definition = readDefinition(lines, first);
    if (definition === undefined) break;
    if (!definitions.has(definition.label)) definitions.set(definition.label, definition.destination);
    first = definition.next;
    if (first >= lines.length || isBlank(lines[first]!.text)) return first;
    if (startsBlockLine(lines, first, depth)) return first;
  }
  const paragraph: string[] = [trimSpaces(lines[first]!.text, true, false)];
  let index = first + 1;
  for (; index < lines.length; index++) {
    const text = lines[index]!.text;
    if (isBlank(text)) break;
    const indent = indentOf(text);
    if (indent < 4) {
      const rest = text.slice(indent);
      // A lazy continuation line is paragraph text: it is not the underline of a heading.
      const level = lines[index]!.lazy === true ? 0 : setextLevel(rest);
      if (level > 0) {
        const previous = out[out.length - 1];
        // The lines between two `---` at the start of a block are front matter, not a heading.
        const frontMatter = level === 2 && previous?.kind === "rule" && previous.blankAfter !== true && previous.line + 1 === lines[first]!.no && rest[0] === "-";
        out.push({ kind: "heading", line: lines[first]!.no, level, lines: paragraph, frontMatter });
        return index + 1;
      }
      if (interruptsParagraph(lines, index, depth)) break;
    }
    paragraph.push(trimSpaces(text, true, false));
  }
  out.push({ kind: "paragraph", line: lines[first]!.no, lines: paragraph });
  return index;
}

/** Whether the line, which is not blank and has an indent below four, ends the paragraph above it. */
function interruptsParagraph(lines: readonly SourceLine[], index: number, depth: number, tables = true): boolean {
  const text = lines[index]!.text;
  const rest = text.slice(indentOf(text));
  if (fenceOpen(rest) !== undefined || isAtxHeading(rest) || isRule(rest)) return true;
  if (depth < MAX_DEPTH && rest.charCodeAt(0) === 0x3e) return true;
  if (depth < MAX_DEPTH) {
    const marker = listMarker(rest);
    // An empty item, or an ordered one that does not start at 1, cannot interrupt a paragraph.
    if (marker !== undefined && !marker.empty && (!marker.ordered || marker.start === 1)) return true;
  }
  if (htmlStart(rest, true) !== undefined) return true;
  return tables && tableStartsAt(lines, index);
}

/**
 * Whether a line that is not indented to the content of a quote or a list item starts a block of its own, so that it is not
 * a lazy continuation of the paragraph the container ends in. Any list item does: the paragraph is not the block it would
 * interrupt (the container is), so an item that does not start at 1 or has no text still starts.
 */
function startsBlockOutside(lines: readonly SourceLine[], index: number, depth: number): boolean {
  const text = lines[index]!.text;
  const rest = text.slice(indentOf(text));
  if (depth < MAX_DEPTH && listMarker(rest) !== undefined) return true;
  // A table's header row is the last line of the paragraph that is open where the table starts: a line that only goes on the
  // paragraph of a quote or an item (lazily) is no header.
  return interruptsParagraph(lines, index, depth, false);
}

// --- HTML blocks ---------------------------------------------------------------------------------------------------

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|" +
  "figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|" +
  "p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_RAW = /^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i;
const HTML_BLOCK_TAG = new RegExp(`^</?(?:${BLOCK_TAGS})(?:[ \\t]|/?>|$)`, "i");
const HTML_ALONE_TAG = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;
/** A complete tag alone on a line, tested only on short lines: the pattern has nested repeats. */
const MAX_ALONE_TAG_LENGTH = 512;

/** The closing marker of an HTML block of type 1 to 5 (found on a line), or "" for 6 and 7 (a blank line ends it). */
type HtmlEnd = RegExp | "";

function htmlStart(rest: string, interrupting: boolean): HtmlEnd | undefined {
  if (rest.charCodeAt(0) !== 0x3c) return undefined;
  if (HTML_RAW.test(rest)) return /<\/(?:script|pre|style|textarea)>/i;
  if (rest.startsWith("<!--")) return /-->/;
  if (rest.startsWith("<?")) return /\?>/;
  if (rest.startsWith("<![CDATA[")) return /\]\]>/;
  if (/^<![A-Za-z]/.test(rest)) return />/;
  if (HTML_BLOCK_TAG.test(rest)) return "";
  if (!interrupting && rest.length <= MAX_ALONE_TAG_LENGTH && HTML_ALONE_TAG.test(rest)) return "";
  return undefined;
}

function readHtml(lines: readonly SourceLine[], start: number, end: HtmlEnd, out: Block[]): number {
  const html: string[] = [];
  let index = start;
  for (; index < lines.length; index++) {
    const text = lines[index]!.text;
    if (end === "" && isBlank(text)) break;
    html.push(stripColumns(lines[index]!, 0));
    if (end !== "" && end.test(text)) {
      index++;
      break;
    }
  }
  out.push({ kind: "html", line: lines[start]!.no, lines: html });
  return index;
}

// --- quotes --------------------------------------------------------------------------------------------------------

function readQuote(lines: readonly SourceLine[], start: number, depth: number, out: Block[], definitions: Map<string, string>): number {
  const inner: SourceLine[] = [];
  let index = start;
  let fence: Fence | undefined;
  let lastWasText = false;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    const indent = indentOf(line.text);
    if (indent < 4 && line.text.charCodeAt(indent) === 0x3e) {
      let content = dropColumns(line, indent + 1);
      if (content.text.charCodeAt(0) === 0x20) content = dropColumns(content, 1);
      else if (content.text.charCodeAt(0) === 0x09) content = { text: expandIndent(content.text), no: line.no };
      inner.push(content);
      [fence, lastWasText] = trackContent(content.text, fence, lastWasText);
      continue;
    }
    // A line without `>` goes on with the paragraph the quote ends in (lazy continuation); anything else ends the quote.
    if (!lastWasText || fence !== undefined || isBlank(line.text) || (indent < 4 && startsBlockOutside(lines, index, depth))) break;
    inner.push(dropColumns(line, 0, true));
  }
  const quote: QuoteBlock = { kind: "quote", line: lines[start]!.no, children: parseBlocks(inner, depth + 1, definitions) };
  out.push(quote);
  return index;
}

/** The fence a line leaves open (or none), and whether the line is text a following line can continue; `wasText` is that for the line before. */
function trackContent(text: string, fence: Fence | undefined, wasText: boolean): [Fence | undefined, boolean] {
  if (fence !== undefined) return [isFenceClose(text, fence) ? undefined : fence, false];
  if (isBlank(text)) return [undefined, false];
  const indent = indentOf(text);
  // An indented line goes on a paragraph that is open, and is code when none is.
  if (indent >= 4) return [undefined, wasText];
  const rest = text.slice(indent);
  const opened = fenceOpen(rest);
  if (opened !== undefined) return [opened, false];
  return [undefined, !isAtxHeading(rest) && !isRule(rest)];
}

// --- lists ---------------------------------------------------------------------------------------------------------

interface Marker {
  readonly ordered: boolean;
  /** The bullet character or the ordered delimiter: items of one list share it. */
  readonly kind: string;
  readonly start: number;
  /** Columns from the line start (after the indent) to the content, as the spec has them. */
  readonly width: number;
  /** The item has nothing after its marker. */
  readonly empty: boolean;
}

/** The list item marker `rest` (without its indent) begins with, if any. */
function listMarker(rest: string): Marker | undefined {
  const first = rest.charCodeAt(0);
  let length: number;
  let ordered = false;
  let kind: string;
  let start = 0;
  if (first === 0x2d || first === 0x2b || first === 0x2a) {
    length = 1;
    kind = rest[0]!;
  } else if (first >= 0x30 && first <= 0x39) {
    let digits = 0;
    while (digits < rest.length && rest.charCodeAt(digits) >= 0x30 && rest.charCodeAt(digits) <= 0x39) digits++;
    if (digits > 9) return undefined;
    const delimiter = rest[digits];
    if (delimiter !== "." && delimiter !== ")") return undefined;
    ordered = true;
    kind = delimiter;
    start = Number(rest.slice(0, digits));
    length = digits + 1;
  } else {
    return undefined;
  }
  const after = rest.slice(length);
  if (after.length > 0 && after[0] !== " " && after[0] !== "\t") return undefined;
  if (isBlank(after)) return { ordered, kind, start, width: length + 1, empty: true };
  const spaces = indentOf(after.replace(/^\t/, "    "));
  // Five or more spaces after the marker: the item's content starts one space after it, and the rest is indented code.
  return { ordered, kind, start, width: length + (spaces >= 5 ? 1 : spaces), empty: false };
}

/** What follows the marker of an item: the line with the marker and the spaces after it off (a tab after the marker is text, as the spec has it). */
function firstItemLine(line: SourceLine, contentColumn: number): SourceLine {
  const rest = dropColumns(line, contentColumn);
  return rest.text.charCodeAt(0) === 0x09 ? { text: expandIndent(rest.text), no: line.no } : rest;
}

function readList(lines: readonly SourceLine[], start: number, depth: number, out: Block[], definitions: Map<string, string>): number {
  const first = listMarker(lines[start]!.text.slice(indentOf(lines[start]!.text)))!;
  const items: ListItem[] = [];
  let loose = false;
  let index = start;
  for (;;) {
    const line = lines[index]!;
    const indent = indentOf(line.text);
    const marker = listMarker(line.text.slice(indent))!;
    const contentColumn = indent + marker.width;
    const body: SourceLine[] = [marker.empty ? { text: "", no: line.no } : firstItemLine(line, contentColumn)];
    let fence: Fence | undefined;
    let lastWasText: boolean;
    [fence, lastWasText] = trackContent(body[0]!.text, undefined, false);
    let blanks: SourceLine[] = [];
    let next = index + 1;
    for (; next < lines.length; next++) {
      const candidate = lines[next]!;
      if (isBlank(candidate.text)) {
        // A blank line inside a fence the item has open is a line of the code.
        if (fence !== undefined) body.push({ text: "", no: candidate.no });
        else blanks.push(candidate);
        continue;
      }
      const candidateIndent = indentOf(candidate.text);
      // An item that starts with an empty line cannot go on after a blank one.
      if (marker.empty && body.length === 1 && blanks.length > 0) break;
      if (candidateIndent >= contentColumn && candidate.lazy !== true) {
        for (const blank of blanks) body.push({ text: "", no: blank.no });
        blanks = [];
        const content = dropColumns(candidate, contentColumn);
        body.push(content);
        [fence, lastWasText] = trackContent(content.text, fence, lastWasText);
        continue;
      }
      // Less indented: the paragraph the item ends in goes on (lazy continuation), or the item is over.
      if (blanks.length === 0 && lastWasText && fence === undefined && !(candidateIndent < 4 && startsBlockOutside(lines, next, depth))) {
        body.push(dropColumns(candidate, 0, true));
        continue;
      }
      break;
    }
    const children = parseBlocks(body, depth + 1, definitions);
    items.push({ line: line.no, children });
    if (children.slice(0, -1).some((child) => child.blankAfter === true)) loose = true;

    const sibling = next < lines.length ? lines[next]! : undefined;
    const siblingRest = sibling === undefined ? "" : sibling.text.slice(indentOf(sibling.text));
    const siblingMarker =
      sibling !== undefined && indentOf(sibling.text) < 4 && !isRule(siblingRest) ? listMarker(siblingRest) : undefined;
    if (siblingMarker === undefined || siblingMarker.ordered !== first.ordered || siblingMarker.kind !== first.kind) {
      index = next - blanks.length;
      break;
    }
    if (blanks.length > 0) loose = true;
    index = next;
  }
  out.push({ kind: "list", line: lines[start]!.no, ordered: first.ordered, tight: !loose, items });
  return index;
}

// --- GFM tables ----------------------------------------------------------------------------------------------------

/** Cells of a table row: split on `|` that is not escaped, an outer pipe on either side not counting. */
function splitRow(text: string): string[] {
  let row = trimSpaces(text);
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index++) {
    const char = row[index]!;
    if (char === "\\" && row[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "|") {
      cells.push(trimSpaces(cell));
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(trimSpaces(cell));
  return cells;
}

function isDelimiterRow(text: string, columns: number): boolean {
  if (indentOf(text) >= 4 || text.indexOf("|") === -1) return false;
  const cells = splitRow(text);
  // GFM wants as many cells as the header; Tika's parser takes more and drops the surplus, and refuses fewer.
  if (cells.length < columns) return false;
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** Whether a table starts at this line: a header row with a pipe in it, and under it a delimiter row of at least as many cells. */
function tableStartsAt(lines: readonly SourceLine[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const header = lines[index]!.text;
  if (header.indexOf("|") === -1 || indentOf(header) >= 4) return false;
  // A delimiter row that only goes on a paragraph lazily (without its quote's `>` or its item's indentation) is not one.
  if (lines[index + 1]!.lazy === true) return false;
  return isDelimiterRow(lines[index + 1]!.text, splitRow(header).length);
}

function readTable(lines: readonly SourceLine[], start: number, depth: number, out: Block[]): number {
  const header = splitRow(lines[start]!.text);
  const rows: string[][] = [];
  let index = start + 2;
  for (; index < lines.length; index++) {
    const text = lines[index]!.text;
    if (isBlank(text)) break;
    const indent = indentOf(text);
    const rest = text.slice(indent);
    if (rest.indexOf("|") !== -1) {
      // A line with a pipe in it is a row, whatever else it looks like; a pipe alone is not a row.
      if (trimSpaces(rest) === "|") break;
    } else {
      // A line without one is a row too, unless it starts another block.
      if (indent >= 4 || fenceOpen(rest) !== undefined || isAtxHeading(rest) || isRule(rest) || htmlStart(rest, true) !== undefined) break;
      if (depth < MAX_DEPTH && (rest.charCodeAt(0) === 0x3e || listMarker(rest) !== undefined)) break;
    }
    const cells = splitRow(text);
    while (cells.length < header.length) cells.push("");
    cells.length = header.length;
    rows.push(cells);
  }
  out.push({ kind: "table", line: lines[start]!.no, header, rows });
  return index;
}
