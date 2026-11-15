import type { Attributes } from "./attributes.ts";
import { ContentHandlerDecorator, type MaybePromise } from "./content-handler.ts";
import type { OutputContentHandler } from "./handler-type.ts";
import { MediaType } from "./media-type.ts";
import type { Metadata } from "./metadata.ts";

/**
 * A piece of a record's content and where it is in the document: a paragraph, a table cell or row, a slide's shape, a
 * line, a JSON value. `ParseOptions.segments` asks for them; see docs/segments.md for the grammar of `location`.
 */
export interface Segment {
  /** The segment's characters: `content.slice(start, end)` of its record, without surrounding whitespace. */
  readonly text: string;
  /** Where `text` starts in the record's `content`, in UTF-16 code units. */
  readonly start: number;
  /** Where `text` ends in the record's `content` (exclusive). */
  readonly end: number;
  /**
   * The names the document gives the segment, outermost first: the headings it is under (a sheet's name, a slide's
   * title), then for a table cell below the first row the first row's cell in its column; for a JSON value the keys
   * of the objects it is in.
   */
  readonly labels: readonly string[];
  /** Where the segment is: `key=value` parts joined by `;`, e.g. `sheet=Vendors;cell=C7` or `ptr=/customers/0/tax_id`. */
  readonly location: string;
}

/**
 * What a parser can say about its document's structure that its XHTML does not. A parser finds this object on
 * `CONTEXT_KEYS.SEGMENT_HINTS`, only when segments were asked for; it reads the key once per parse and calls the hints
 * just before it writes the element they are about. The XHTML itself is not changed by them.
 */
export interface SegmentHints {
  /** How the document's XHTML maps onto its source: "lines", one `p` per source line; "table", the whole document is one table. */
  layout(kind: "lines" | "table"): void;
  /** The block written next is a heading of this level (1 to 6), as if it were an `h1`-`h6`. */
  heading(level: number): void;
  /** The block written next starts at this line (1-based) of the source. */
  line(number: number): void;
  /** The table row written next is this row (1-based) of the sheet: an `r` attribute, which may skip empty rows. */
  row(number: number): void;
  /**
   * The blocks written from now on are a shape's, until the next call or the end of the slide; `undefined` ends the
   * shape. A title shape's text is the heading of what follows it on the slide.
   */
  shape(name: string | undefined, title?: boolean): void;
}

/** The keys of a location, in the order they appear in one. */
export const SEGMENT_LOCATION_KEYS = [
  "page", "slide", "sheet", "part", "shape", "table", "row", "col", "cell", "para", "line", "ptr", "selector",
] as const;

export type SegmentLocationKey = (typeof SEGMENT_LOCATION_KEYS)[number];

/** A location's parts by key, the values unescaped. Throws a RangeError on a string that is not a location. */
export function parseSegmentLocation(location: string): Map<SegmentLocationKey, string> {
  const parts = new Map<SegmentLocationKey, string>();
  let last = -1;
  for (const part of location.split(";")) {
    const equals = part.indexOf("=");
    const key = part.slice(0, equals) as SegmentLocationKey;
    const order = SEGMENT_LOCATION_KEYS.indexOf(key);
    if (equals < 1 || order <= last) throw new RangeError(`not a segment location: ${JSON.stringify(location)}`);
    last = order;
    parts.set(key, decodeURIComponent(part.slice(equals + 1)));
  }
  return parts;
}

/**
 * The segments of a record that no other segment makes redundant, in the order they came in. A row is the cells it
 * holds, a pptx shape the table in it; a segment whose characters are all (apart from whitespace) in the segments
 * inside it is dropped, so each character is in one segment and a value's segment is the cell, not the row. A segment
 * with text of its own, such as a list item with a nested list, stays. Pass a record's `segments`, in the order it has them.
 */
export function leafSegments(segments: readonly Segment[]): Segment[] {
  return segments.filter((_, index) => !isMadeOfParts(segments, index));
}

/** Whether the segments that start inside the one at `index` (and end inside it) hold all of its non-whitespace characters. */
function isMadeOfParts(segments: readonly Segment[], index: number): boolean {
  const whole = segments[index]!;
  let covered = whole.start;
  let hasParts = false;
  for (let next = index + 1; next < segments.length; next++) {
    const part = segments[next]!;
    if (part.start >= whole.end) break;
    if (part.end > whole.end) continue;
    if (part.start > covered && /\S/.test(whole.text.slice(covered - whole.start, part.start - whole.start))) return false;
    hasParts = true;
    covered = Math.max(covered, part.end);
  }
  return hasParts && !/\S/.test(whole.text.slice(covered - whole.start));
}

function escapeValue(value: string): string {
  return /[%;=\r\n]/.test(value) ? value.replace(/[%;=\r\n]/g, (char) => encodeURIComponent(char)) : value;
}

function columnLetters(column: number): string {
  let letters = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

const BLOCKS: ReadonlySet<string> = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "blockquote", "dt", "dd", "address", "caption", "figcaption",
]);
const CONTAINERS: ReadonlyMap<string, "page" | "slide" | "sheet"> = new Map([
  ["page", "page"], ["slide", "slide"], ["sheet", "sheet"],
]);
const PARTS: ReadonlyMap<string, string> = new Map([
  ["header", "header"], ["footer", "footer"], ["footnote", "footnote"], ["endnote", "endnote"],
  ["comment", "comment"], ["notes", "notes"], ["slide-notes", "notes"],
]);

type Kind = "block" | "cell" | "row" | "shape" | "implicit" | "title";

/** A segment being written: where it started, and what its location and labels will be made of. */
interface Pending {
  readonly kind: Kind;
  /** When it opened, among all segments: a row opens before its cells, which may span the same characters. */
  readonly order: number;
  readonly start: number;
  /** Depth of the element it belongs to (the anchor of an implicit one). */
  readonly depth: number;
  /** The table it is in: a row's or a cell's. */
  readonly table: TableState | undefined;
  readonly heading: number;
  /** The source line (lines layout, or a hint), 0 for none. */
  readonly line: number;
  readonly shape: string | undefined;
  readonly title: boolean;
  /** html: the element's selector. */
  readonly selector: string | undefined;
  hasText: boolean;
  /** The segment's kept characters, gathered only when they are needed (a heading, a header cell, a tsv line). */
  capture: string | undefined;
}

interface TableState {
  readonly ordinal: number;
  row: number;
  col: number;
  /** The sheet's row number of the current row, from a row hint; 0 when not hinted. */
  rowNumber: number;
  readonly headers: string[];
  labelVersion: number;
  readonly labels: Map<number, readonly string[]>;
}

interface Frame {
  readonly name: string;
  readonly nth: number;
  readonly id: string | undefined;
  children: Map<string, number> | undefined;
  readonly table: TableState | undefined;
  readonly part: string | undefined;
  readonly previousPart: string | undefined;
  readonly container: boolean;
}

interface Done {
  readonly order: number;
  readonly start: number;
  readonly end: number;
  readonly labels: readonly string[];
  readonly location: string;
}

type TextKind = "plain" | "json" | "tsv";

const NO_LABELS: readonly string[] = Object.freeze([]);

/**
 * Follows the XHTML of one record on its way into the record's own content handler and notes where each segment's
 * characters land there. It sits behind the output budget, so it sees exactly the characters the record keeps; it
 * forwards every event unchanged.
 */
export class SegmentTap extends ContentHandlerDecorator implements SegmentHints {
  readonly #content: OutputContentHandler;
  readonly #metadata: Metadata;
  readonly #done: Done[] = [];
  readonly #frames: Frame[] = [];
  readonly #tables: TableState[] = [];
  #html = false;
  #layout: "lines" | "table" | undefined;
  #textKind: TextKind = "plain";
  #selectorRoot = -1;

  #block: Pending | undefined;
  #cell: Pending | undefined;
  #row: Pending | undefined;
  #shape: Pending | undefined;

  #container: { readonly key: "page" | "slide" | "sheet"; value: string; named: boolean } | undefined;
  #containerCount = new Map<string, number>();
  #part: string | undefined;
  #para = 0;
  #tableCount = 0;
  #lineCount = 0;
  #order = 0;
  readonly #lineStarts: number[] = [];
  readonly #headings: string[] = ["", "", "", "", "", ""];
  #headingVersion = 0;
  #headingLabels: readonly string[] = NO_LABELS;
  #headingLabelsVersion = 0;

  #nextHeading = 0;
  #nextLine = 0;
  #nextRow = 0;

  constructor(content: OutputContentHandler, metadata: Metadata) {
    super(content);
    this.#content = content;
    this.#metadata = metadata;
  }

  // --- hints ---------------------------------------------------------------------------------------------------------

  layout(kind: "lines" | "table"): void {
    this.#layout = kind;
  }

  heading(level: number): void {
    if (Number.isInteger(level) && level >= 1 && level <= 6) this.#nextHeading = level;
  }

  line(number: number): void {
    if (Number.isSafeInteger(number) && number > 0) this.#nextLine = number;
  }

  row(number: number): void {
    if (Number.isSafeInteger(number) && number > 0) this.#nextRow = number;
  }

  shape(name: string | undefined, title = false): void {
    this.#closeShape();
    if (name === undefined) return;
    this.#closeImplicit();
    this.#shape = this.#open("shape", this.#frames.length, { shape: name, title, capture: title });
  }

  // --- events --------------------------------------------------------------------------------------------------------

  override startElement(uri: string, localName: string, qName: string, attributes: Attributes): MaybePromise<void> {
    this.#start((localName || qName).toLowerCase(), attributes);
    return super.startElement(uri, localName, qName, attributes);
  }

  override endElement(uri: string, localName: string, qName: string): MaybePromise<void> {
    this.#end();
    return super.endElement(uri, localName, qName);
  }

  override characters(ch: string, start: number, length: number): MaybePromise<void> {
    const before = this.#length();
    const sent = super.characters(ch, start, length);
    if (sent instanceof Promise) return sent.then(() => this.#kept(ch, start, before));
    this.#kept(ch, start, before);
  }

  /** The record's content so far, in characters: the content handler's own string, whose length costs nothing. */
  #length(): number {
    return this.#content.toString().length;
  }

  #kept(ch: string, start: number, before: number): void {
    const count = this.#length() - before;
    if (count <= 0) return;
    const text = ch.slice(start, start + count);
    const visible = /\S/.test(text);
    if (this.#block === undefined && this.#cell === undefined && this.#row === undefined && this.#shape === undefined) {
      // Text outside any block still belongs somewhere: to the element it is in, up to the next block. (The segment
      // starts where the text did: the characters were counted already.)
      if (visible) this.#block = { ...this.#open("implicit", this.#frames.length, { capture: false }), start: before, hasText: true };
      return;
    }
    for (const pending of [this.#block, this.#cell, this.#row, this.#shape]) {
      if (pending === undefined) continue;
      if (visible) pending.hasText = true;
      if (pending.capture !== undefined) pending.capture += text;
    }
  }

  #start(name: string, attributes: Attributes): void {
    const parent = this.#frames.at(-1);
    let nth = 1;
    if (this.#html && parent !== undefined) {
      parent.children ??= new Map();
      nth = (parent.children.get(name) ?? 0) + 1;
      parent.children.set(name, nth);
    }
    const className = name === "div" ? attributes.getValueByQName("class") ?? "" : "";
    const containerKey = CONTAINERS.get(className);
    const part = PARTS.get(className);
    const isTable = name === "table";
    const structural = isTable || name === "tr" || name === "td" || name === "th" || BLOCKS.has(name) ||
      containerKey !== undefined || part !== undefined;
    if (structural) this.#closeImplicit();

    let table: TableState | undefined;
    if (isTable) {
      table = { ordinal: ++this.#tableCount, row: 0, col: 0, rowNumber: 0, headers: [], labelVersion: -1, labels: new Map() };
      this.#tables.push(table);
    }
    if (containerKey !== undefined) this.#startContainer(containerKey);
    const previousPart = this.#part;
    if (part !== undefined) {
      this.#closeShape();
      this.#part = part;
      // A slide's notes stay under the slide's title; a header, a footer or a note is outside the headings.
      if (part !== "notes") this.#resetHeadings();
    }
    this.#frames.push({
      name,
      nth,
      id: this.#html ? attributes.getValueByQName("id") ?? undefined : undefined,
      children: undefined,
      table,
      part,
      previousPart,
      container: containerKey !== undefined,
    });
    const depth = this.#frames.length;

    if (name === "body") {
      this.#startBody(depth);
    } else if (name === "title") {
      if (this.#block === undefined) this.#block = this.#open("title", depth, { capture: false });
    } else if (name === "tr") {
      const current = this.#tables.at(-1);
      if (current !== undefined) {
        current.row++;
        current.col = 0;
        current.rowNumber = this.#nextRow;
        this.#nextRow = 0;
        if (this.#row === undefined && this.#cell === undefined) {
          this.#row = this.#open("row", depth, { table: current, capture: false });
        }
      }
    } else if (name === "td" || name === "th") {
      const current = this.#tables.at(-1);
      if (current !== undefined) {
        current.col++;
        if (this.#cell === undefined && this.#block === undefined && this.#row?.table === current) {
          this.#cell = this.#open("cell", depth, { table: current, capture: current.row === 1 });
        }
      }
    } else if (BLOCKS.has(name)) {
      const heading = /^h[1-6]$/.test(name) ? Number(name[1]) : this.#nextHeading;
      let line = this.#nextLine;
      if (this.#layout === "lines" && name === "p") {
        this.#lineStarts.push(this.#length());
        line = ++this.#lineCount;
      }
      this.#nextHeading = 0;
      this.#nextLine = 0;
      if (this.#block === undefined && this.#cell === undefined && this.#shape === undefined) {
        const capture = heading > 0 || (this.#layout === "lines" && this.#textKind === "tsv");
        this.#block = this.#open("block", depth, { heading, line, capture });
      }
    }
  }

  #end(): void {
    const depth = this.#frames.length;
    const frame = this.#frames.pop();
    if (frame === undefined) return;
    if (this.#block !== undefined && this.#block.depth >= depth) this.#closeBlock();
    if (this.#cell !== undefined && this.#cell.depth >= depth) this.#closeCell();
    if (this.#row !== undefined && this.#row.depth >= depth) this.#closeRow();
    if (frame.table !== undefined) this.#tables.pop();
    if (frame.part !== undefined) {
      this.#closeShape();
      this.#part = frame.previousPart;
    }
    if (frame.container) this.#closeShape();
    if (this.#selectorRoot >= this.#frames.length) this.#selectorRoot = -1;
  }

  #startBody(depth: number): void {
    this.#selectorRoot = depth - 1;
    const type = MediaType.parse(this.#metadata.get("Content-Type"))?.getBaseType().toString() ?? "";
    this.#html = type === "text/html" || type === "application/xhtml+xml";
    if (type === "text/tab-separated-values") this.#textKind = "tsv";
    else if (type === "application/json" || type.endsWith("+json")) this.#textKind = "json";
  }

  #startContainer(key: "page" | "slide" | "sheet"): void {
    this.#closeShape();
    const count = (this.#containerCount.get(key) ?? 0) + 1;
    this.#containerCount.set(key, count);
    this.#container = { key, value: String(count), named: key !== "sheet" };
    this.#para = 0;
    this.#tableCount = 0;
    this.#resetHeadings();
  }

  #resetHeadings(): void {
    if (this.#headings.every((heading) => heading === "")) return;
    this.#headings.fill("");
    this.#headingVersion++;
  }

  #open(
    kind: Kind,
    depth: number,
    fields: {
      readonly table?: TableState;
      readonly heading?: number;
      readonly line?: number;
      readonly shape?: string;
      readonly title?: boolean;
      readonly capture: boolean;
    },
  ): Pending {
    return {
      kind,
      order: this.#order++,
      start: this.#length(),
      depth,
      table: fields.table,
      heading: fields.heading ?? 0,
      line: fields.line ?? 0,
      shape: fields.shape ?? this.#shape?.shape,
      title: fields.title ?? false,
      selector: this.#html ? this.#selector(depth) : undefined,
      hasText: false,
      capture: fields.capture ? "" : undefined,
    };
  }

  #closeImplicit(): void {
    if (this.#block?.kind === "implicit") this.#closeBlock();
  }

  #closeBlock(): void {
    const block = this.#block!;
    this.#block = undefined;
    if (block.kind === "block" && this.#layout === "lines" && this.#textKind === "tsv") {
      this.#tsvRow(block);
      return;
    }
    if (block.heading === 1) this.#nameContainer(block.capture ?? "");
    if (!block.hasText) return;
    if (block.kind !== "title" && block.line === 0) this.#para++;
    let location: string;
    if (block.kind === "title") location = "part=title";
    else if (block.selector !== undefined) location = `selector=${escapeValue(block.selector)}`;
    else location = this.#prefix(block.shape) + (block.line > 0 ? `line=${block.line}` : `para=${this.#para}`);
    this.#push(block, location, this.#baseLabels());
    if (block.heading > 0) this.#setHeading(block.heading, block.capture ?? "");
  }

  #closeCell(): void {
    const cell = this.#cell!;
    this.#cell = undefined;
    const table = cell.table!;
    if (table.row === 1) table.headers[table.col - 1] = (cell.capture ?? "").trim();
    if (!cell.hasText) return;
    let location: string;
    if (cell.selector !== undefined) location = `selector=${escapeValue(cell.selector)}`;
    else if (table.rowNumber > 0) location = `${this.#prefix(cell.shape)}cell=${columnLetters(table.col)}${table.rowNumber}`;
    else location = `${this.#prefix(cell.shape)}${this.#tablePart(table)}row=${table.row};col=${table.col}`;
    this.#push(cell, location, table.row > 1 ? this.#columnLabels(table, table.col) : this.#baseLabels());
  }

  #closeRow(): void {
    const row = this.#row!;
    this.#row = undefined;
    if (this.#cell !== undefined) this.#closeCell();
    if (!row.hasText) return;
    const table = row.table!;
    let location: string;
    if (row.selector !== undefined) location = `selector=${escapeValue(row.selector)}`;
    else location = `${this.#prefix(row.shape)}${this.#tablePart(table)}row=${table.rowNumber > 0 ? table.rowNumber : table.row}`;
    this.#push(row, location, this.#baseLabels());
  }

  #closeShape(): void {
    const shape = this.#shape;
    if (shape === undefined) return;
    if (this.#block !== undefined) this.#closeBlock();
    this.#shape = undefined;
    if (!shape.hasText) return;
    const location = this.#prefix(undefined) + `shape=${escapeValue(shape.shape ?? "")}`;
    this.#push(shape, location, this.#baseLabels());
    if (shape.title) this.#setHeading(1, shape.capture ?? "");
  }

  /** A tab-separated line: a row, and a cell per field, the first line's fields being the column labels. */
  #tsvRow(line: Pending): void {
    const text = line.capture ?? "";
    const fields = text.split("\t");
    const end = line.start + text.length;
    const table = this.#tables[0] ?? this.#tsvTable();
    table.row = line.line;
    if (line.line === 1) fields.forEach((field, index) => (table.headers[index] = field.trim()));
    if (!line.hasText) return;
    this.#done.push({ order: line.order, start: line.start, end, labels: this.#baseLabels(), location: `row=${line.line}` });
    let offset = line.start;
    fields.forEach((field, index) => {
      if (/\S/.test(field)) {
        const labels = line.line > 1 ? this.#columnLabels(table, index + 1) : this.#baseLabels();
        const location = `row=${line.line};col=${index + 1}`;
        this.#done.push({ order: line.order, start: offset, end: offset + field.length, labels, location });
      }
      offset += field.length + 1;
    });
  }

  #tsvTable(): TableState {
    const table: TableState = { ordinal: 1, row: 0, col: 0, rowNumber: 0, headers: [], labelVersion: -1, labels: new Map() };
    this.#tables.push(table);
    return table;
  }

  #push(pending: Pending, location: string, labels: readonly string[]): void {
    this.#done.push({ order: pending.order, start: pending.start, end: this.#length(), labels, location });
  }

  #prefix(shape: string | undefined): string {
    let prefix = "";
    if (this.#container !== undefined) prefix += `${this.#container.key}=${escapeValue(this.#container.value)};`;
    if (this.#part !== undefined) prefix += `part=${this.#part};`;
    if (shape !== undefined) prefix += `shape=${escapeValue(shape)};`;
    return prefix;
  }

  /** `table=N;`, unless the document or the sheet is a single table. */
  #tablePart(table: TableState): string {
    return this.#layout === "table" || this.#container?.key === "sheet" ? "" : `table=${table.ordinal};`;
  }

  /** A sheet is named by the first top-level heading its parser writes in it; until then, by its number. */
  #nameContainer(text: string): void {
    const container = this.#container;
    if (container === undefined || container.named) return;
    container.named = true;
    const name = text.trim();
    if (name.length > 0) container.value = name;
  }

  #setHeading(level: number, text: string): void {
    const heading = text.trim();
    this.#headings[level - 1] = heading;
    for (let deeper = level; deeper < 6; deeper++) this.#headings[deeper] = "";
    this.#headingVersion++;
  }

  #baseLabels(): readonly string[] {
    if (this.#headingLabelsVersion !== this.#headingVersion) {
      this.#headingLabels = Object.freeze(this.#headings.filter((heading) => heading.length > 0));
      this.#headingLabelsVersion = this.#headingVersion;
    }
    return this.#headingLabels;
  }

  #columnLabels(table: TableState, col: number): readonly string[] {
    const header = table.headers[col - 1] ?? "";
    if (header.length === 0) return this.#baseLabels();
    if (table.labelVersion !== this.#headingVersion) {
      table.labels.clear();
      table.labelVersion = this.#headingVersion;
    }
    let labels = table.labels.get(col);
    if (labels === undefined) {
      labels = Object.freeze([...this.#baseLabels(), header]);
      table.labels.set(col, labels);
    }
    return labels;
  }

  /** The element at `depth` as a CSS selector from the body: ids where they are plain, `:nth-of-type` elsewhere. */
  #selector(depth: number): string {
    let selector = "";
    for (let index = depth - 1; index > this.#selectorRoot; index--) {
      const frame = this.#frames[index]!;
      if (frame.id !== undefined && /^[A-Za-z][\w-]*$/.test(frame.id)) return `#${frame.id}${selector}`;
      // A browser puts table rows in a tbody the XHTML may not have, so a row is any descendant of its table.
      const combinator = frame.name === "tr" ? " " : " > ";
      selector = `${combinator}${frame.name}:nth-of-type(${frame.nth})${selector}`;
    }
    return `body${selector}`;
  }

  // --- the end -------------------------------------------------------------------------------------------------------

  /** The segments of the finished record whose content is `content`: each trimmed, empty ones dropped, in content order. */
  finish(content: string): Segment[] {
    while (this.#frames.length > 0) this.#end();
    this.#closeShape();
    if (this.#layout === "lines" && this.#textKind === "json") {
      const values = jsonSegments(content, this.#lineStarts);
      if (values !== undefined) return values;
    }
    const trimmed: Done[] = [];
    for (const done of this.#done) {
      let start = done.start;
      let end = Math.min(done.end, content.length);
      while (start < end && isSpace(content.charCodeAt(start))) start++;
      while (end > start && isSpace(content.charCodeAt(end - 1))) end--;
      if (start < end) trimmed.push({ ...done, start, end });
    }
    // Content order; of two that start together, the longer (the row) first, then the one opened first.
    trimmed.sort((left, right) => left.start - right.start || right.end - left.end || left.order - right.order);
    return trimmed.map(({ start, end, labels, location }) =>
      Object.freeze({ text: content.slice(start, end), start, end, labels, location }));
  }
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c || code === 0xa0;
}

/**
 * A segment per scalar of the JSON text `content`, located by its JSON Pointer and labelled with the keys above it;
 * several top-level values (JSON Lines) each get the `line=` their value starts on. Undefined when the text is not JSON.
 */
function jsonSegments(content: string, lineStarts: readonly number[]): Segment[] | undefined {
  const segments: Segment[] = [];
  let index = 0;
  const skip = (): void => {
    while (index < content.length && isSpace(content.charCodeAt(index))) index++;
  };
  /** The end of the string token whose opening quote is at `index`, past its closing quote; -1 when unclosed. */
  const stringEnd = (from: number): number => {
    for (let at = from + 1; at < content.length; at++) {
      const char = content.charCodeAt(at);
      if (char === 0x5c) at++;
      else if (char === 0x22) return at + 1;
    }
    return -1;
  };
  interface Open { readonly array: boolean; key: string | number; count: number }
  const stack: Open[] = [];
  const labelsOf = (path: readonly (string | number)[]): readonly string[] =>
    Object.freeze(path.filter((step): step is string => typeof step === "string"));
  const pointer = (path: readonly (string | number)[]): string =>
    path.map((step) => `/${String(step).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
  let topLevel = 0;
  const scalar = (start: number, end: number): void => {
    if (end <= start) return;
    const path = stack.map((open) => open.key);
    segments.push({
      text: content.slice(start, end),
      start,
      end,
      labels: labelsOf(path),
      location: `ptr=${escapeValue(pointer(path))}`,
    });
  };
  for (;;) {
    skip();
    if (index >= content.length) break;
    if (stack.length === 0) topLevel++;
    const open = stack.at(-1);
    // Expect a value (or, in an object, a key first).
    if (open !== undefined && !open.array) {
      const char = content[index];
      if (char === "}") {
        stack.pop();
        index++;
        if (!afterValue()) return undefined;
        continue;
      }
      if (char !== "\"") return undefined;
      const end = stringEnd(index);
      if (end < 0) return undefined;
      let key: string;
      try {
        key = JSON.parse(content.slice(index, end)) as string;
      } catch {
        return undefined;
      }
      open.key = key;
      index = end;
      skip();
      if (content[index] !== ":") return undefined;
      index++;
      skip();
    } else if (open !== undefined && content[index] === "]") {
      stack.pop();
      index++;
      if (!afterValue()) return undefined;
      continue;
    } else if (open !== undefined) {
      open.key = open.count;
    }
    const char = content[index];
    if (char === "{" || char === "[") {
      if (stack.length >= 1000) return undefined;
      stack.push({ array: char === "[", key: "", count: 0 });
      index++;
      continue;
    }
    if (char === "\"") {
      const end = stringEnd(index);
      if (end < 0) return undefined;
      scalar(index + 1, end - 1);
      index = end;
    } else {
      const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(content.slice(index, index + 64));
      if (match === null) return undefined;
      scalar(index, index + match[0].length);
      index += match[0].length;
    }
    if (!afterValue()) return undefined;
  }
  if (stack.length > 0) return undefined;
  if (topLevel > 1) {
    // JSON Lines: say which line each value is on.
    return segments.map((segment) =>
      Object.freeze({ ...segment, location: `line=${lineOf(lineStarts, segment.start)};${segment.location}` }),
    );
  }
  return segments.map((segment) => Object.freeze(segment));

  /** After a value: a comma (the next member or element), the end of its container, or the end of a top-level value. */
  function afterValue(): boolean {
    skip();
    const open = stack.at(-1);
    if (open === undefined) return true;
    open.count++;
    const char = content[index];
    if (char === ",") {
      index++;
      return true;
    }
    return char === (open.array ? "]" : "}");
  }
}

function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lineStarts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}
