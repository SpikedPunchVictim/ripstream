import { createDecoder, recordDetectedEncoding } from "./charset.ts";
import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { detectEncoding } from "@spikedpunch/ripstream-mime";
import { javaIsBlank } from "./java-compat.ts";

/** A study file is a table of a few hundred rows; this bounds one that never ends. */
export const DEFAULT_MAX_ISATAB_BYTES = 32 * 1024 * 1024;
/** Study tables have tens of columns; this bounds a row that is only delimiters. */
export const DEFAULT_MAX_ISATAB_COLUMNS = 100_000;

const ISATAB_MIME_TYPE = "application/x-isatab";
/** ISATabUtils.ISATAB: `KeyPrefix.file("isatab:", ...)`. */
const ISATAB_PREFIX = "isatab:";

export interface ISArchiveParserOptions {
  /** Maximum size of the study file in bytes (default {@link DEFAULT_MAX_ISATAB_BYTES}); a larger one is a LimitExceededError. */
  readonly maxBytes?: number;
  /** Maximum cells in one row (default {@link DEFAULT_MAX_ISATAB_COLUMNS}); a wider row is a LimitExceededError. */
  readonly maxColumns?: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

/**
 * Port of Tika's ISArchiveParser (tika-parser-scientific-module) for the study file of an ISA-Tab archive
 * (`application/x-isatab`: `s_*.txt`, a tab-separated table whose first line starts with `"Source Name"`).
 *
 * Tika's parser is given one file of an archive that is a directory, and reads its neighbours by name: the investigation file
 * (`i_*.txt` beside the study file) for `isatab:` metadata and an `<h1>INVESTIGATION ...</h1>` heading, and the assay files the
 * investigation names for one `<div><h3>ASSAY name</h3>` table each. A stream has no neighbours, so only the part that needs
 * the study file alone is ported: `<h2>STUDY null</h2>` (the study identifier comes from the investigation file, so Tika's
 * string concatenation writes `null` for a lone stream) and the study table, one `<th>` per cell of the first record and one
 * `<tr>` per later record. No `isatab:` metadata is written. This is what Tika writes for a stream it spools to a temporary
 * file, unless that temporary directory happens to hold exactly one `i_*.txt`.
 *
 * The table is read as commons-csv's `CSVFormat.TDF`: tab-delimited, `"` quotes with `""` for a quote inside, spaces around a
 * value ignored, empty lines skipped. An unfinished quote or text after a closing quote is a MalformedDocumentError (commons-csv
 * throws an IOException that Tika does not catch).
 *
 * Differences from Tika, all read from the source and not run against a Tika:
 *  - A study over `maxBytes`, or a row wider than `maxColumns`, is a LimitExceededError. Tika reads it all.
 *  - The character set comes from ripstream's detector, not Tika's AutoDetectReader. `tk:detected-encoding` is written;
 *    `tk:encoding-detector` is not, as there is no Tika detector to name.
 */
export class ISArchiveParser implements Parser {
  readonly name = "ISArchiveParser";
  readonly #maxBytes: number;
  readonly #maxColumns: number;

  constructor(options: ISArchiveParserOptions = {}) {
    this.#maxBytes = positiveInteger("maxBytes", options.maxBytes ?? DEFAULT_MAX_ISATAB_BYTES);
    this.#maxColumns = positiveInteger("maxColumns", options.maxColumns ?? DEFAULT_MAX_ISATAB_COLUMNS);
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(ISATAB_MIME_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const tick = signalCheckpoint(ctx);
    const bytes = await stream.readFully(this.#maxBytes);
    const { decoder, charset } = createDecoder(detectEncoding(bytes.subarray(0, 64 * 1024)).charset);
    recordDetectedEncoding(metadata, charset);
    const records = tdfRecords(decoder.decode(bytes), this.#maxColumns);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    // ISArchiveParser.parseStudy: the identifier is read back from the metadata the investigation file filled, and is
    // missing here, which Java's string concatenation writes as "null".
    await xhtml.element("h2", `STUDY ${metadata.get(`${ISATAB_PREFIX}Study Identifier`)}`);
    await xhtml.startElement("table");
    await xhtml.startElement("thead");
    const head = records.next();
    if (head.done !== true) await writeCells(xhtml, "th", head.value);
    await xhtml.endElement("thead");
    await xhtml.startElement("tbody");
    for (const record of records) {
      tick();
      await xhtml.startElement("tr");
      await writeCells(xhtml, "td", record);
      await xhtml.endElement("tr");
    }
    await xhtml.endElement("tbody");
    await xhtml.endElement("table");
    await xhtml.endDocument();
  }
}

async function writeCells(xhtml: XHTMLContentHandler, tag: "th" | "td", cells: readonly string[]): Promise<void> {
  for (const cell of cells) {
    await xhtml.startElement(tag);
    await xhtml.characters(cell);
    await xhtml.endElement(tag);
  }
}

// What the commons-csv Lexer works with: characters as numbers, with two markers for "no character yet" and "end of input".
const EOF = -1;
const UNDEFINED = -2;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;

type TokenType = "TOKEN" | "EORECORD" | "EOF";

interface Token {
  readonly type: TokenType;
  readonly content: string;
  /** An EOF token that carries a value (the input ended inside a record). */
  readonly ready: boolean;
}

/** Character.isWhitespace, except the delimiter (commons-csv's Lexer.isWhitespace). */
function isWhitespace(ch: number): boolean {
  return ch !== TAB && ch >= 0 && javaIsBlank(String.fromCharCode(ch));
}

/**
 * The records of `text` as commons-csv 1.x reads it with `CSVFormat.TDF` (`DEFAULT` with a tab delimiter and
 * ignoreSurroundingSpaces): Lexer.nextToken, parseSimpleToken, parseEncapsulatedToken and CSVParser.nextRecord, with no
 * escape character, no comment marker, no header and no null string. One record is held at a time. Every call of the token
 * reader consumes at least one character or ends the input, so the loops end with the text.
 */
function* tdfRecords(text: string, maxColumns: number): Generator<string[]> {
  let position = 0;
  let lastChar = UNDEFINED;

  const read = (): number => {
    if (position >= text.length) {
      lastChar = EOF;
      return EOF;
    }
    lastChar = text.charCodeAt(position++);
    return lastChar;
  };
  const lookAhead = (): number => (position >= text.length ? EOF : text.charCodeAt(position));

  /** A line ends at LF, CR or CRLF; a CR that starts a CRLF takes the LF with it. */
  const readEndOfLine = (ch: number): boolean => {
    let current = ch;
    if (current === CR && lookAhead() === LF) current = read();
    return current === LF || current === CR;
  };
  const isStartOfLine = (ch: number): boolean => ch === LF || ch === CR || ch === UNDEFINED;

  const malformed = (why: string): MalformedDocumentError =>
    new MalformedDocumentError(`ISA-Tab table: ${why} (line ${lineAt(text, position)})`);

  const encapsulatedToken = (): Token => {
    let content = "";
    for (;;) {
      const c = read();
      if (c === QUOTE) {
        if (lookAhead() === QUOTE) {
          read();
          content += '"';
          continue;
        }
        // The closing quote: only whitespace may follow before the delimiter or the end of the line.
        for (;;) {
          const after = read();
          if (after === TAB) return { type: "TOKEN", content, ready: false };
          if (after === EOF) return { type: "EOF", content, ready: true };
          if (readEndOfLine(after)) return { type: "EORECORD", content, ready: false };
          if (!isWhitespace(after)) throw malformed("text between a quoted value and the next delimiter");
        }
      }
      if (c === EOF) throw malformed("the input ended before a quoted value was closed");
      content += String.fromCharCode(c);
    }
  };

  const simpleToken = (first: number): Token => {
    const start = position - 1;
    let ch = first;
    let type: TokenType;
    let end: number;
    for (;;) {
      if (readEndOfLine(ch)) {
        type = "EORECORD";
        end = lineEnd(text, start, position);
        break;
      }
      if (ch === EOF) {
        type = "EOF";
        end = text.length;
        break;
      }
      if (ch === TAB) {
        type = "TOKEN";
        end = position - 1;
        break;
      }
      ch = read();
    }
    // ignoreSurroundingSpaces: trailing whitespace of an unquoted value is dropped (trimTrailingSpaces).
    while (end > start && javaIsBlank(text.charAt(end - 1))) end--;
    return { type, content: text.slice(start, end), ready: type === "EOF" };
  };

  const nextToken = (): Token => {
    let lastBefore = lastChar;
    let c = read();
    let eol = readEndOfLine(c);

    // Empty lines are skipped: a line end straight after a line end, or at the start of the input.
    while (eol && isStartOfLine(lastBefore)) {
      lastBefore = c;
      c = read();
      eol = readEndOfLine(c);
      if (c === EOF) return { type: "EOF", content: "", ready: false };
    }
    // The input ended after the last value, not after a delimiter: nothing more.
    if (lastBefore === EOF || (lastBefore !== TAB && c === EOF)) return { type: "EOF", content: "", ready: false };

    // ignoreSurroundingSpaces: whitespace before a value is skipped, but not past the end of the line.
    while (isWhitespace(c) && !eol) {
      c = read();
      eol = readEndOfLine(c);
    }
    if (c === TAB) return { type: "TOKEN", content: "", ready: false };
    if (eol) return { type: "EORECORD", content: "", ready: false };
    if (c === QUOTE) return encapsulatedToken();
    if (c === EOF) return { type: "EOF", content: "", ready: true };
    return simpleToken(c);
  };

  // CSVParser.nextRecord: tokens are added to a record until one ends it.
  for (;;) {
    const record: string[] = [];
    let type: TokenType;
    do {
      const token = nextToken();
      type = token.type;
      if (type === "TOKEN" || type === "EORECORD" || token.ready) {
        if (record.length >= maxColumns) throw new LimitExceededError(`an ISA-Tab row has more than ${maxColumns} cells`);
        record.push(token.content);
      }
    } while (type === "TOKEN");
    if (record.length === 0) return;
    yield record;
    if (type === "EOF") return;
  }
}

/** The line number (from 1) of an offset, counting CRLF, CR and LF as one break each; for an error message only. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    const ch = text.charCodeAt(index);
    if (ch === LF || (ch === CR && text.charCodeAt(index + 1) !== LF)) line++;
  }
  return line;
}

/** Where an unquoted value ends when a line break ended it: before the CR or LF just read (and the LF of a CRLF). */
function lineEnd(text: string, start: number, positionAfterBreak: number): number {
  let end = positionAfterBreak - 1;
  if (end > start && text.charCodeAt(end) === LF && text.charCodeAt(end - 1) === CR) end--;
  return end;
}
