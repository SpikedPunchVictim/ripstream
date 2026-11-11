import { createDecoder, withCharset } from "./charset.ts";
import {
  LimitExceededError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { detectEncoding } from "@spikedpunch/ripstream-mime";
import {
  CSV_DELIMITER_NAMES,
  DEFAULT_CSV_MARK_LIMIT,
  DEFAULT_CSV_MIN_CONFIDENCE,
  bestCsvDelimiter,
} from "./csv-sniffer.ts";
import { TextParser, writeText } from "./text.ts";

/**
 * Structural events the scanner streams to the XHTML handler. Rows and cells are
 * never buffered: each event is emitted as soon as it is known, so `<tr>`/`<td>`
 * stay balanced while a row is still being scanned.
 */
export type CsvEvent =
  | { readonly kind: "startRow" }
  | { readonly kind: "startCell" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "endCell" }
  | { readonly kind: "endRow" };

const START_ROW: CsvEvent = Object.freeze({ kind: "startRow" });
const START_CELL: CsvEvent = Object.freeze({ kind: "startCell" });
const END_CELL: CsvEvent = Object.freeze({ kind: "endCell" });
const END_ROW: CsvEvent = Object.freeze({ kind: "endRow" });

/** A cell's pending text is flushed to the handler once it reaches this many UTF-16 units (pieces never exceed it by more than one code point). */
export const CSV_CELL_FLUSH_CHARS = 64 * 1024;

/**
 * Default ceiling on characters in one row. Not a memory bound: memory safety comes
 * from streaming cells to the handler plus the output cap (maxOutputChars). This is an
 * optional product limit on pathological rows that a service may raise or lower via
 * {@link CsvParserOptions}.
 */
export const DEFAULT_MAX_CSV_ROW_CHARS = 10_000_000;
/** Default ceiling on cells in one row; same product-limit rationale as above. */
export const DEFAULT_MAX_CSV_CELLS_PER_ROW = 1_000_000;

export interface CsvParserOptions {
  /**
   * Maximum characters of cell content in a single row (default
   * {@link DEFAULT_MAX_CSV_ROW_CHARS}). Exceeding it throws LimitExceededError.
   */
  readonly maxRowChars?: number;
  /**
   * Maximum cells in a single row (default {@link DEFAULT_MAX_CSV_CELLS_PER_ROW}).
   * Exceeding it throws LimitExceededError.
   */
  readonly maxCellsPerRow?: number;
  /**
   * Characters (not bytes) of the document the sniffer reads to tell a table from text (default 20,000), as Tika's
   * `TextAndCSVConfig.markLimit`.
   */
  readonly markLimit?: number;
  /**
   * The confidence (0 to 1) a delimiter needs for the document to be read as a table (default 0.5), as Tika's
   * `TextAndCSVConfig.minConfidence`. At the default a table needs eleven regular rows, or quoted cells, to be told from
   * text; Tika's own tests use 0.2.
   */
  readonly minConfidence?: number;
  /**
   * One character: read every document this parser is given as a table with this delimiter, and sniff nothing. Not in
   * Tika, whose parser always sniffs unless a document carries a content-type override. For a pipeline known to carry
   * delimited columns whatever their length or regularity. Metadata is written as for a sniffed table.
   */
  readonly delimiter?: string;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/** The types Tika's TextAndCSVParser sniffs. */
const SNIFFED_TYPES: ReadonlySet<string> = new Set(["text/plain", "text/csv", "text/tsv"]);

/**
 * Port of TextAndCSVParser, for `text/plain`, `text/csv` and `text/tsv`: it sniffs the start of the document (Tika's
 * CSVSniffer, see {@link bestCsvDelimiter}) and reads a table when it finds regular delimited columns, and text
 * otherwise. A table is a streaming state machine with quoted fields, doubled quotes and CRLF support; cells are
 * streamed to the handler as they complete (long cells in bounded pieces), so memory stays flat for newline-free bodies;
 * the output cap bounds how much of such a body is processed. Other text types, `text/tab-separated-values` among them,
 * are {@link TextParser}'s and are not sniffed.
 */
export class CsvParser implements Parser {
  readonly name = "CsvParser";
  readonly #maxRowChars: number;
  readonly #maxCellsPerRow: number;
  readonly #markLimit: number;
  readonly #minConfidence: number;
  readonly #delimiter: string | null;
  readonly #text = new TextParser();

  constructor(options: CsvParserOptions = {}) {
    this.#maxRowChars = positiveInteger(
      "maxRowChars",
      options.maxRowChars ?? DEFAULT_MAX_CSV_ROW_CHARS,
    );
    this.#maxCellsPerRow = positiveInteger(
      "maxCellsPerRow",
      options.maxCellsPerRow ?? DEFAULT_MAX_CSV_CELLS_PER_ROW,
    );
    this.#markLimit = positiveInteger("markLimit", options.markLimit ?? DEFAULT_CSV_MARK_LIMIT);
    this.#minConfidence = options.minConfidence ?? DEFAULT_CSV_MIN_CONFIDENCE;
    if (!Number.isFinite(this.#minConfidence)) {
      throw new RangeError(`minConfidence must be a finite number, got ${this.#minConfidence}`);
    }
    const delimiter = options.delimiter ?? null;
    if (delimiter !== null && (delimiter.length !== 1 || delimiter === '"' || delimiter === "\n" || delimiter === "\r")) {
      throw new RangeError(`delimiter must be one character other than a quote or a line break, got ${JSON.stringify(delimiter)}`);
    }
    this.#delimiter = delimiter;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([...SNIFFED_TYPES].map((type) => MediaType.parse(type)!));
  }

  /** The delimiter of the table the start of the document is, or null when it is text. */
  #sniff(head: Uint8Array, charset: string): string | null {
    const window = createDecoder(charset).decoder.decode(head).slice(0, this.#markLimit);
    return bestCsvDelimiter(window, { markLimit: this.#markLimit, minConfidence: this.#minConfidence });
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    // The registry hands this parser every subtype of text/plain that has none of its own (as Tika's does), and Tika does
    // not sniff a type other than text/plain, text/csv and text/tsv: it reads it as text and keeps the type.
    const incoming = MediaType.parse(metadata.get("Content-Type"))?.getBaseType().toString();
    if (incoming !== undefined && !SNIFFED_TYPES.has(incoming)) {
      await this.#text.parse(stream, handler, metadata, ctx);
      return;
    }
    // Enough bytes for the sniffer's window at up to four bytes a character; the encoding is detected from the first 64 KiB.
    const head = await stream.peek(this.#markLimit * 4);
    const { decoder, charset } = createDecoder(detectEncoding(head.subarray(0, 64 * 1024)).charset);
    metadata.set("Content-Encoding", charset);

    const delimiter = this.#delimiter ?? this.#sniff(head, charset);
    if (delimiter === null) {
      // Tika rebuilds the type from text/plain whatever came in: a text/csv that is not a table is text/plain.
      metadata.set("Content-Type", withCharset(null, "text/plain", charset));
      await writeText(stream, handler, metadata, decoder);
      return;
    }
    // Tika names the delimiters it knows, and writes the code of any other in Content-Type (and no csv:delimiter).
    const delimiterName = CSV_DELIMITER_NAMES.get(delimiter);
    metadata.set(
      "Content-Type",
      MediaType.parseOrThrow(delimiter === "\t" ? "text/tsv" : "text/csv")
        .withParameters({ charset, delimiter: delimiterName ?? String(delimiter.charCodeAt(0)) })
        .toString(),
    );
    if (delimiterName !== undefined) metadata.set("csv:delimiter", delimiterName);

    const scanner = new CsvScanner({
      maxRowChars: this.#maxRowChars,
      maxCellsPerRow: this.#maxCellsPerRow,
    });
    scanner.setDelimiter(delimiter);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    let tableOpen = false;
    let rows = 0;
    let firstRowCells = 0;

    // XHTMLContentHandler serializes calls and does no nesting validation, so each
    // event is forwarded (and awaited) the moment the scanner produces it.
    const drain = async (events: Iterable<CsvEvent>): Promise<void> => {
      for (const event of events) {
        switch (event.kind) {
          case "startRow":
            if (!tableOpen) {
              await xhtml.startElement("table");
              tableOpen = true;
            }
            await xhtml.startElement("tr");
            break;
          case "startCell":
            if (rows === 0) firstRowCells++;
            await xhtml.startElement("td");
            break;
          case "text":
            await xhtml.characters(event.text);
            break;
          case "endCell":
            await xhtml.endElement("td");
            break;
          case "endRow":
            await xhtml.endElement("tr");
            if (rows++ === 0) metadata.setInt("csv:num-columns", firstRowCells);
            break;
        }
      }
    };

    for await (const chunk of stream) {
      await drain(scanner.write(decoder.decode(chunk, { stream: true })));
    }
    const rest = decoder.decode();
    if (rest.length > 0) await drain(scanner.write(rest));
    await drain(scanner.end());
    if (tableOpen) await xhtml.endElement("table");
    metadata.setInt("csv:num-rows", rows);
    await xhtml.endDocument();
  }
}

export interface CsvScannerLimits {
  readonly maxRowChars: number;
  readonly maxCellsPerRow: number;
}

/**
 * Exported for the differential fuzz test only; not part of the package API.
 *
 * Synchronous scanner exposed as lazy generators: `write()`/`end()` must be fully
 * drained by the caller (which awaits the handler between events). Each input
 * character produces a bounded number of events, so nothing grows with row length.
 * Held state is O(1 cell): at most CSV_CELL_FLUSH_CHARS of pending cell text.
 */
export class CsvScanner {
  private readonly limits: CsvScannerLimits;
  private readonly out: CsvEvent[] = [];
  private delimiter = ",";
  /** Cell text not yet forwarded (flushed in pieces, so not the whole cell). */
  private field = "";
  /** True once any content has been appended to the current cell, even if already flushed. */
  private cellStarted = false;
  /** Completed cells in the current row. */
  private cells = 0;
  private rowOpen = false;
  private cellOpen = false;
  private inQuotes = false;
  private pendingQuote = false;
  private skipLf = false;
  private rowChars = 0;

  constructor(limits: CsvScannerLimits) {
    this.limits = limits;
  }

  setDelimiter(delimiter: string): void {
    this.delimiter = delimiter;
  }

  *write(text: string): Generator<CsvEvent> {
    const out = this.out;
    for (const char of text) {
      this.step(char);
      if (out.length > 0) {
        for (let index = 0; index < out.length; index++) yield out[index]!;
        out.length = 0;
      }
    }
  }

  *end(): Generator<CsvEvent> {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.cellStarted || this.cells > 0) this.endRow();
    const out = this.out;
    for (let index = 0; index < out.length; index++) yield out[index]!;
    out.length = 0;
  }

  private step(char: string): void {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (char === '"') {
        this.append('"');
        return;
      }
      this.inQuotes = false;
    }

    if (this.inQuotes) {
      if (char === '"') this.pendingQuote = true;
      else this.append(char);
      return;
    }

    if (char === '"' && !this.cellStarted) {
      this.inQuotes = true;
      return;
    }

    if (char === this.delimiter) {
      this.endCell();
      this.skipLf = false;
      return;
    }

    if (char === "\r") {
      this.endRow();
      this.skipLf = true;
      return;
    }

    if (char === "\n") {
      if (this.skipLf) {
        this.skipLf = false;
        return;
      }
      this.endRow();
      return;
    }

    this.skipLf = false;
    this.append(char);
  }

  private append(char: string): void {
    // `char` is a whole code point (callers iterate by code point), so a flush never
    // splits a surrogate pair.
    this.field += char;
    this.cellStarted = true;
    if (++this.rowChars > this.limits.maxRowChars) {
      throw new LimitExceededError(
        `CSV row exceeds ${this.limits.maxRowChars} characters without a row terminator ` +
          "(raise CsvParserOptions.maxRowChars to allow longer rows)",
      );
    }
    if (this.field.length >= CSV_CELL_FLUSH_CHARS) this.flushText();
  }

  /** Opens the row and cell lazily: a row is only opened once it is known to be non-blank. */
  private openCell(): void {
    if (!this.rowOpen) {
      this.rowOpen = true;
      this.out.push(START_ROW);
    }
    if (!this.cellOpen) {
      this.cellOpen = true;
      this.out.push(START_CELL);
    }
  }

  private flushText(): void {
    if (this.field.length === 0) return;
    this.openCell();
    this.out.push({ kind: "text", text: this.field });
    this.field = "";
  }

  private closeCell(): void {
    this.openCell();
    this.flushText();
    this.out.push(END_CELL);
    this.cellOpen = false;
    this.cellStarted = false;
    this.cells++;
  }

  private endCell(): void {
    // A delimiter means this row has at least two cells, so it is never blank.
    this.closeCell();
    if (this.cells > this.limits.maxCellsPerRow) {
      throw new LimitExceededError(
        `CSV row exceeds ${this.limits.maxCellsPerRow} cells without a row terminator ` +
          "(raise CsvParserOptions.maxCellsPerRow to allow wider rows)",
      );
    }
  }

  private endRow(): void {
    // A row is blank only when it is a single empty cell: emit nothing for it.
    if (this.cells > 0 || this.cellStarted) {
      this.closeCell();
      this.out.push(END_ROW);
    }
    this.field = "";
    this.cellStarted = false;
    this.cells = 0;
    this.rowOpen = false;
    this.cellOpen = false;
    this.rowChars = 0;
    this.skipLf = false;
  }
}
