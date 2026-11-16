import type { Attributes } from "./attributes.ts";
import { ContentHandlerDecorator, type MaybePromise } from "./content-handler.ts";
import type { OutputContentHandler } from "./handler-type.ts";
import { MediaType } from "./media-type.ts";
import type { Metadata } from "./metadata.ts";
import { TIKA_KEYS } from "./tika-keys.ts";

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
  /**
   * The block written next is a heading of this level (1 to 6), as if it were an `h1`-`h6`. `title` is the heading's text when
   * the block holds more than that (a markdown setext heading is written with its underline); labels are made of it.
   */
  heading(level: number, title?: string): void;
  /**
   * With layout "lines": the lines are rows of delimited cells (a csv that was not read as a table), the first row naming the
   * columns. The segments are then the cells, located `row=R;col=C` and labelled by their column's header, and the
   * lines are not segments. One character other than a quote or a line break; anything else is ignored.
   */
  delimited(delimiter: string): void;
  /** The block written next starts at this line (1-based) of the source. */
  line(number: number): void;
  /** The table row written next is this row (1-based) of the sheet: an `r` attribute, which may skip empty rows. */
  row(number: number): void;
  /**
   * The block written next is this paragraph (1-based) of the document: a parser that leaves empty paragraphs out says where the written
   * ones are. The blocks after it, which have no hint, go on from it.
   */
  para(number: number): void;
  /** The table cell written next is this column (1-based) of its row: a parser that leaves empty cells out says where the written ones are. */
  col(number: number): void;
  /**
   * The blocks written from now on are a shape's, until the next call or the end of the slide; `undefined` ends the
   * shape. A title shape's text is the heading of what follows it on the slide.
   */
  shape(name: string | undefined, title?: boolean): void;
  /**
   * The page, slide or sheet written next has this label (a PDF's `/PageLabels` entry, "iv" or "A-3"): it is added, first, to
   * the `labels` of every segment in it. The location still counts pages from 1; a label is additive. `undefined` for none.
   */
  pageLabel(label: string | undefined): void;
  /**
   * The text written from now on is an AcroForm field's, until the next call; `undefined` ends it. It is one segment located
   * `field=<name>` (a second field of the page with the name has `~2`, ...), labelled with the field's full name.
   */
  field(name: string | undefined): void;
}

/** The keys of a location, in the order they appear in one. */
export const SEGMENT_LOCATION_KEYS = [
  "page", "slide", "sheet", "part", "shape", "field", "table", "row", "col", "cell", "para", "line", "ptr", "selector",
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

/**
 * What the locations and labels of one record's segments may hold, in characters: a base for documents whose structure is
 * dense (a spreadsheet's `sheet=...;cell=C7` per few characters of text) plus eight per output character (measured, a
 * sheet needs about five). Without it a JSON pointer per scalar holds every key above it, so key length times scalar
 * count is built whatever the output limit: a 98 KB document of one 30,000-character key above 34,000 scalars used over
 * 1 GB. A record that would go over is given line segments instead (the text is kept), flagged `tk:segments-degraded`.
 */
export const SEGMENT_LOCATION_BASE_CHARS = 24 * 1024 * 1024;
export const SEGMENT_LOCATION_CHARS_PER_OUTPUT_CHAR = 8;
const SEGMENT_LOCATION_CEILING_CHARS = 256 * 1024 * 1024;

/** Characters of location and label one record may hold when its output is limited to `maxOutputChars`. */
export function segmentLocationAllowance(maxOutputChars: number): number {
  const wanted = SEGMENT_LOCATION_BASE_CHARS + Math.max(0, maxOutputChars) * SEGMENT_LOCATION_CHARS_PER_OUTPUT_CHAR;
  return Number.isFinite(wanted) ? Math.min(wanted, SEGMENT_LOCATION_CEILING_CHARS) : SEGMENT_LOCATION_CEILING_CHARS;
}

/** What a label slot costs against the allowance: a reference, not the key's characters, which are shared. */
const LABEL_SLOT_CHARS = 8;

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
  /** A hint's own text for the heading, when the block's text is more than that. */
  readonly headingTitle: string | undefined;
  /** The source line (lines layout, or a hint), 0 for none. */
  readonly line: number;
  /** The paragraph number a hint gave the block, 0 for none (it goes on from the last). */
  readonly para: number;
  readonly shape: string | undefined;
  /** An AcroForm field's segment: the location value (unique on the page), and the field's own full name. */
  readonly field: string | undefined;
  readonly fieldName: string | undefined;
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
  /** The label of the container (a PDF page's label) and the one the next container will have. */
  #containerLabel: string | undefined;
  #nextContainerLabel: string | undefined;
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

  #delimiter: string | undefined;
  /** The shape and field names a slide, page (or its notes) has used so far, by kind and part. */
  readonly #shapeNames = new Map<string, Set<string>>();
  #nextHeading = 0;
  #nextHeadingTitle: string | undefined;
  #nextLine = 0;
  #nextPara = 0;
  #nextRow = 0;
  #nextCol = 0;

  /** What is left of the record's location allowance; see `segmentLocationAllowance`. */
  #allowance: number;
  readonly #degraded = new Set<string>();

  constructor(content: OutputContentHandler, metadata: Metadata, options: { readonly locationAllowance?: number } = {}) {
    super(content);
    this.#content = content;
    this.#metadata = metadata;
    this.#allowance = options.locationAllowance ?? segmentLocationAllowance(100_000);
  }

  /** Takes `chars` from the allowance, or says that it is spent, and notes on the metadata which kind of location went without. */
  #afford(kind: "ptr" | "selector" | "cell", chars: number): boolean {
    if (chars <= this.#allowance) {
      this.#allowance -= chars;
      return true;
    }
    if (!this.#degraded.has(kind)) {
      this.#degraded.add(kind);
      this.#metadata.add(TIKA_KEYS.SEGMENTS_DEGRADED, kind);
    }
    return false;
  }

  // --- hints ---------------------------------------------------------------------------------------------------------

  layout(kind: "lines" | "table"): void {
    this.#layout = kind;
  }

  delimited(delimiter: string): void {
    if (delimiter.length === 1 && delimiter !== '"' && delimiter !== "\n" && delimiter !== "\r") this.#delimiter = delimiter;
  }

  heading(level: number, title?: string): void {
    if (Number.isInteger(level) && level >= 1 && level <= 6) {
      this.#nextHeading = level;
      this.#nextHeadingTitle = title;
    }
  }

  line(number: number): void {
    if (Number.isSafeInteger(number) && number > 0) this.#nextLine = number;
  }

  para(number: number): void {
    if (Number.isSafeInteger(number) && number > 0) this.#nextPara = number;
  }

  row(number: number): void {
    if (Number.isSafeInteger(number) && number > 0) this.#nextRow = number;
  }

  col(number: number): void {
    if (Number.isSafeInteger(number) && number > 0) this.#nextCol = number;
  }

  shape(name: string | undefined, title = false): void {
    this.#closeShape();
    if (name === undefined) return;
    this.#closeImplicit();
    this.#shape = this.#open("shape", this.#frames.length, { shape: this.#uniqueName("shape", name), title, capture: title });
  }

  pageLabel(label: string | undefined): void {
    this.#nextContainerLabel = label;
  }

  field(name: string | undefined): void {
    this.#closeShape();
    if (name === undefined) return;
    this.#closeImplicit();
    this.#shape = this.#open("shape", this.#frames.length, { field: this.#uniqueName("field", name), fieldName: name, capture: false });
  }

  /**
   * The name a shape or a field is located by: its own, and for a second one of the slide or page with the same name `~2`,
   * `~3` ..., so that `(path, location)` stays unique. A slide's notes are a part of their own, so they have their own names.
   */
  #uniqueName(kind: "shape" | "field", name: string): string {
    const part = `${kind}:${this.#part ?? ""}`;
    let used = this.#shapeNames.get(part);
    if (used === undefined) this.#shapeNames.set(part, (used = new Set()));
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}~${n}`;
    used.add(unique);
    return unique;
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
        current.col = this.#nextCol > 0 ? this.#nextCol : current.col + 1;
        this.#nextCol = 0;
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
      const headingTitle = heading === this.#nextHeading ? this.#nextHeadingTitle : undefined;
      this.#nextHeading = 0;
      this.#nextHeadingTitle = undefined;
      this.#nextLine = 0;
      const para = this.#nextPara;
      this.#nextPara = 0;
      if (this.#block === undefined && this.#cell === undefined && this.#shape === undefined) {
        const capture = heading > 0 || (this.#layout === "lines" && this.#textKind === "tsv");
        this.#block = this.#open("block", depth, { heading, headingTitle, line, para, capture });
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
    this.#shapeNames.clear();
    if (this.#containerLabel !== this.#nextContainerLabel) this.#headingVersion++;
    this.#containerLabel = this.#nextContainerLabel;
    this.#nextContainerLabel = undefined;
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
      readonly headingTitle?: string | undefined;
      readonly line?: number;
      readonly para?: number;
      readonly shape?: string;
      readonly field?: string;
      readonly fieldName?: string;
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
      headingTitle: fields.headingTitle,
      line: fields.line ?? 0,
      para: fields.para ?? 0,
      shape: fields.shape ?? this.#shape?.shape,
      field: fields.field,
      fieldName: fields.fieldName,
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
    const title = block.headingTitle ?? block.capture ?? "";
    if (block.heading === 1) this.#nameContainer(title);
    if (!block.hasText) return;
    if (block.kind !== "title" && block.line === 0) this.#para = block.para > 0 ? block.para : this.#para + 1;
    let location: string;
    if (block.kind === "title") location = "part=title";
    else if (block.selector !== undefined) location = `selector=${escapeValue(block.selector)}`;
    else location = this.#prefix(block.shape) + (block.line > 0 ? `line=${block.line}` : `para=${this.#para}`);
    this.#push(block, location, this.#baseLabels());
    if (block.heading > 0) this.#setHeading(block.heading, title);
  }

  #closeCell(): void {
    const cell = this.#cell!;
    this.#cell = undefined;
    const table = cell.table!;
    if (table.row === 1) table.headers[table.col - 1] = (cell.capture ?? "").trim();
    if (!cell.hasText) return;
    let location: string;
    if (cell.selector !== undefined) location = `selector=${escapeValue(cell.selector)}`;
    else if (table.rowNumber > 0 && this.#tablePart(table) === "") {
      location = `${this.#prefix(cell.shape)}cell=${columnLetters(table.col)}${table.rowNumber}`;
    } else {
      const row = table.rowNumber > 0 ? table.rowNumber : table.row;
      location = `${this.#prefix(cell.shape)}${this.#tablePart(table)}row=${row};col=${table.col}`;
    }
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
    if (shape.field !== undefined) {
      this.#push(shape, `${this.#prefix(undefined)}field=${escapeValue(shape.field)}`, [...this.#baseLabels(), shape.fieldName ?? shape.field]);
      return;
    }
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
      const headings = this.#headings.filter((heading) => heading.length > 0);
      this.#headingLabels = Object.freeze(this.#containerLabel === undefined ? headings : [this.#containerLabel, ...headings]);
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

  /**
   * The element at `depth` as a CSS selector from the body: ids where they are plain, `:nth-of-type` elsewhere. Undefined
   * when it would not fit the allowance (the segment is then located by its paragraph).
   */
  #selector(depth: number): string | undefined {
    const parts: string[] = [];
    let head = "body";
    let length = 0;
    for (let index = depth - 1; index > this.#selectorRoot; index--) {
      const frame = this.#frames[index]!;
      if (frame.id !== undefined && /^[A-Za-z][\w-]*$/.test(frame.id)) {
        head = `#${frame.id}`;
        break;
      }
      // A browser puts table rows in a tbody the XHTML may not have, so a row is any descendant of its table.
      const combinator = frame.name === "tr" ? " " : " > ";
      const part = `${combinator}${frame.name}:nth-of-type(${frame.nth})`;
      parts.push(part);
      length += part.length;
    }
    if (!this.#afford("selector", head.length + length)) return undefined;
    return head + parts.reverse().join("");
  }

  // --- the end -------------------------------------------------------------------------------------------------------

  /** The segments of the finished record whose content is `content`: each trimmed, empty ones dropped, in content order. */
  finish(content: string): Segment[] {
    while (this.#frames.length > 0) this.#end();
    this.#closeShape();
    if (this.#layout === "lines" && this.#delimiter !== undefined) {
      const cells = delimitedSegments(content, this.#delimiter, (chars) => this.#afford("cell", chars));
      if (cells !== undefined) return cells;
    }
    if (this.#layout === "lines" && this.#textKind === "json") {
      const values = jsonSegments(content, this.#lineStarts, (chars) => this.#afford("ptr", chars));
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
function jsonSegments(content: string, lineStarts: readonly number[], afford: (chars: number) => boolean): Segment[] | undefined {
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
  let refused = false;
  const scalar = (start: number, end: number): void => {
    if (end <= start) return;
    // A string of spaces holds no value, like an empty one (the other layouts drop blank segments too).
    if (!/\S/.test(content.slice(start, end))) return;
    const path = stack.map((open) => open.key);
    // Charged before the pointer is built: its length (escapes aside) is the keys and a slash each.
    let cost = 0;
    let named = 0;
    for (const step of path) {
      cost += 1 + String(step).length;
      if (typeof step === "string") named++;
    }
    if (!afford(cost + named * LABEL_SLOT_CHARS)) {
      refused = true;
      return;
    }
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
      if (refused) return undefined;
      index = end;
    } else {
      const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(content.slice(index, index + 64));
      if (match === null) return undefined;
      scalar(index, index + match[0].length);
      if (refused) return undefined;
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

/**
 * A segment per non-blank cell of `content` read as delimited rows (csv, as `CsvScanner` reads a table: a quote opens a quoted
 * cell only at its start, a doubled quote is one quote, a quoted cell may hold line breaks, a row that is one empty cell is
 * blank and not counted). A quoted cell's segment is its characters between the quotes, so doubled quotes stay doubled; a label is
 * the header with them undoubled. Undefined when the locations would not fit the allowance.
 */
function delimitedSegments(content: string, delimiter: string, afford: (chars: number) => boolean): Segment[] | undefined {
  interface Cell { readonly start: number; readonly end: number; readonly quoted: boolean }
  const segments: Segment[] = [];
  const headers: string[] = [];
  const labelsOfColumn: (readonly string[] | undefined)[] = [];
  const length = content.length;
  let index = 0;
  let row = 0;
  while (index < length) {
    const cells: Cell[] = [];
    for (;;) {
      let start = index;
      let end: number;
      let quoted = false;
      if (content[index] === '"') {
        quoted = true;
        start = ++index;
        for (;;) {
          const quote = content.indexOf('"', index);
          if (quote < 0 || content[quote + 1] !== '"') {
            end = quote < 0 ? length : quote;
            index = quote < 0 ? length : quote + 1;
            break;
          }
          index = quote + 2;
        }
        // Characters after the closing quote belong to the cell, as the scanner appends them.
        const after = index;
        while (index < length && content[index] !== delimiter && content[index] !== "\n" && content[index] !== "\r") index++;
        if (index > after) end = index;
      } else {
        while (index < length && content[index] !== delimiter && content[index] !== "\n" && content[index] !== "\r") index++;
        end = index;
      }
      cells.push({ start, end, quoted });
      if (content[index] === delimiter) {
        index++;
        continue;
      }
      if (content[index] === "\r" && content[index + 1] === "\n") index++;
      index++;
      break;
    }
    if (cells.length === 1 && cells[0]!.end === cells[0]!.start) continue;
    row++;
    for (let col = 1; col <= cells.length; col++) {
      const cell = cells[col - 1]!;
      let start = cell.start;
      let end = cell.end;
      while (start < end && isSpace(content.charCodeAt(start))) start++;
      while (end > start && isSpace(content.charCodeAt(end - 1))) end--;
      if (row === 1) {
        const header = content.slice(start, end);
        headers[col - 1] = cell.quoted ? header.replace(/""/g, '"') : header;
      }
      if (start >= end) continue;
      if (!afford(String(row).length + String(col).length + 9)) return undefined;
      let labels = NO_LABELS;
      if (row > 1 && (headers[col - 1] ?? "").length > 0) {
        labels = labelsOfColumn[col - 1] ??= Object.freeze([headers[col - 1]!]);
      }
      segments.push(Object.freeze({ text: content.slice(start, end), start, end, labels, location: `row=${row};col=${col}` }));
    }
  }
  return segments;
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
