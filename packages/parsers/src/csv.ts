import { createDecoder } from "./charset.ts";
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
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/**
 * Port of TextAndCSVParser's CSV side. Streaming state machine with delimiter
 * sniffing, quoted fields, doubled quotes, and CRLF support. Cells are streamed to the
 * handler as they complete (long cells in bounded pieces), so memory stays flat for
 * newline-free bodies; the output cap bounds how much of such a body is processed.
 */
export class CsvParser implements Parser {
  readonly name = "CsvParser";
  readonly #maxRowChars: number;
  readonly #maxCellsPerRow: number;

  constructor(options: CsvParserOptions = {}) {
    this.#maxRowChars = positiveInteger(
      "maxRowChars",
      options.maxRowChars ?? DEFAULT_MAX_CSV_ROW_CHARS,
    );
    this.#maxCellsPerRow = positiveInteger(
      "maxCellsPerRow",
      options.maxCellsPerRow ?? DEFAULT_MAX_CSV_CELLS_PER_ROW,
    );
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([
      MediaType.parse("text/csv")!,
      MediaType.parse("text/tab-separated-values")!,
    ]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const prefix = await stream.peek(64 * 1024);
    const { decoder, charset } = createDecoder(detectEncoding(prefix).charset);
    metadata.set("Content-Encoding", charset);

    const scanner = new CsvScanner({
      maxRowChars: this.#maxRowChars,
      maxCellsPerRow: this.#maxCellsPerRow,
    });
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    let tableOpen = false;

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
            break;
        }
      }
    };

    let buffered = "";
    let delimiter: string | null = null;

    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      if (delimiter === null) {
        const firstLine = findFirstLine(buffered);
        if (firstLine === null && buffered.length < 64 * 1024) continue;
        delimiter = sniffDelimiter(firstLine ?? buffered);
        scanner.setDelimiter(delimiter);
      }
      const text = buffered;
      buffered = "";
      await drain(scanner.write(text));
    }

    buffered += decoder.decode();
    if (buffered.length > 0) {
      if (delimiter === null) {
        delimiter = sniffDelimiter(findFirstLine(buffered) ?? buffered);
        scanner.setDelimiter(delimiter);
      }
      await drain(scanner.write(buffered));
    }
    await drain(scanner.end());
    if (tableOpen) await xhtml.endElement("table");
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

function findFirstLine(text: string): string | null {
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) return text.slice(0, index);
  }
  return null;
}

function sniffDelimiter(line: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = countOutsideQuotes(line, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, needle: string): number {
  let quoted = false;
  let count = 0;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === needle) count++;
  }
  return count;
}
