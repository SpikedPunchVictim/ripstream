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

type CsvEvent = { readonly type: "row"; readonly cells: readonly string[] };

// Resiliency stopgap for #23: a row with no terminator otherwise buffers the whole
// (body-capped, ~9x-amplified) input in `field`/`row` and never hits the output cap,
// OOMing the process. Both caps bound that: MAX_CELLS_PER_ROW catches a comma bomb
// (millions of empty cells), MAX_ROW_CHARS catches one giant unterminated cell. Values
// are generous vs any legitimate CSV; the proper fix is the streaming-row redesign
// tracked separately.
const MAX_ROW_CHARS = 10_000_000;
const MAX_CELLS_PER_ROW = 1_000_000;

/**
 * Port of TextAndCSVParser's CSV side. Streaming state machine with delimiter
 * sniffing, quoted fields, doubled quotes, and CRLF support.
 */
export class CsvParser implements Parser {
  readonly name = "CsvParser";

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

    const events: CsvEvent[] = [];
    const scanner = new CsvScanner(events);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    let tableOpen = false;

    const flush = async (): Promise<void> => {
      if (events.length === 0) return;
      if (!tableOpen) {
        await xhtml.startElement("table");
        tableOpen = true;
      }
      while (events.length > 0) {
        const event = events.shift()!;
        await xhtml.startElement("tr");
        for (const cell of event.cells) {
          await xhtml.startElement("td");
          if (cell.length > 0) await xhtml.characters(cell);
          await xhtml.endElement("td");
        }
        await xhtml.endElement("tr");
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
      scanner.write(buffered);
      buffered = "";
      await flush();
    }

    buffered += decoder.decode();
    if (buffered.length > 0) {
      if (delimiter === null) {
        delimiter = sniffDelimiter(findFirstLine(buffered) ?? buffered);
        scanner.setDelimiter(delimiter);
      }
      scanner.write(buffered);
    }
    scanner.end();
    await flush();
    if (tableOpen) await xhtml.endElement("table");
    await xhtml.endDocument();
  }
}

class CsvScanner {
  private readonly events: CsvEvent[];
  private delimiter = ",";
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private pendingQuote = false;
  private skipLf = false;
  private rowChars = 0;

  constructor(events: CsvEvent[]) {
    this.events = events;
  }

  setDelimiter(delimiter: string): void {
    this.delimiter = delimiter;
  }

  private appendField(char: string): void {
    this.field += char;
    if (++this.rowChars > MAX_ROW_CHARS) {
      throw new LimitExceededError(
        `CSV row exceeds ${MAX_ROW_CHARS} buffered characters without a row terminator`,
      );
    }
  }

  write(text: string): void {
    for (const char of text) {
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (char === '"') {
          this.appendField('"');
          continue;
        }
        this.inQuotes = false;
      }

      if (this.inQuotes) {
        if (char === '"') this.pendingQuote = true;
        else this.appendField(char);
        continue;
      }

      if (char === '"' && this.field.length === 0) {
        this.inQuotes = true;
        continue;
      }

      if (char === this.delimiter) {
        this.row.push(this.field);
        this.field = "";
        this.skipLf = false;
        if (this.row.length > MAX_CELLS_PER_ROW) {
          throw new LimitExceededError(
            `CSV row exceeds ${MAX_CELLS_PER_ROW} cells without a row terminator`,
          );
        }
        continue;
      }

      if (char === "\r") {
        this.emitRow();
        this.skipLf = true;
        continue;
      }

      if (char === "\n") {
        if (this.skipLf) {
          this.skipLf = false;
          continue;
        }
        this.emitRow();
        continue;
      }

      this.skipLf = false;
      this.appendField(char);
    }
  }

  end(): void {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.field.length > 0 || this.row.length > 0) this.emitRow();
  }

  private emitRow(): void {
    this.row.push(this.field);
    this.field = "";
    if (this.row.length > 1 || this.row[0]?.length !== 0) {
      this.events.push({ type: "row", cells: this.row });
    }
    this.row = [];
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
