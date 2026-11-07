import { createDecoder } from "./charset.ts";
import {
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

  constructor(events: CsvEvent[]) {
    this.events = events;
  }

  setDelimiter(delimiter: string): void {
    this.delimiter = delimiter;
  }

  write(text: string): void {
    for (const char of text) {
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (char === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
      }

      if (this.inQuotes) {
        if (char === '"') this.pendingQuote = true;
        else this.field += char;
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
      this.field += char;
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
