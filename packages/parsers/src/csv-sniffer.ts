/**
 * Port of Tika 4.2.0's CSVSniffer, with the defaults of TextAndCSVConfig: it decides whether a text document is
 * delimited columns (a table) or plain text by trying each delimiter on the start of the document. Read from Tika
 * source, not run against a Tika.
 *
 * Not ported: the TIKA-4278 rule that distrusts a colon (colon is not one of the default delimiters), and configurable
 * delimiters.
 */

export const DEFAULT_CSV_MARK_LIMIT = 20_000;
export const DEFAULT_CSV_MIN_CONFIDENCE = 0.5;

/**
 * The delimiters and the names Tika writes for them (`csv:delimiter`, and `delimiter=` in Content-Type). The order is
 * the iteration order of the Java HashMap Tika keeps them in, which decides ties between equally confident delimiters.
 */
export const CSV_DELIMITER_NAMES: ReadonlyMap<string, string> = new Map([
  ["\t", "tab"],
  [";", "semicolon"],
  [",", "comma"],
  ["|", "pipe"],
]);

export interface CsvSniffOptions {
  /** Characters (not bytes) of the document that are read. Default {@link DEFAULT_CSV_MARK_LIMIT}. */
  readonly markLimit?: number;
  /** The confidence a delimiter needs to make the document a table. Default {@link DEFAULT_CSV_MIN_CONFIDENCE}. */
  readonly minConfidence?: number;
}

export interface CsvSniffResult {
  readonly delimiter: string;
  readonly confidence: number;
}

const EOF = -1;
const NEW_LINE = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const QUOTE = 34;

/** What Java's EOFException subclasses say in Tika's Snifflet. One instance each: they carry no information. */
class SniffEof extends Error {}
class UnsurprisingEof extends SniffEof {}
class HitMarkLimit extends SniffEof {}
const EOF_ERROR = new SniffEof();
const UNSURPRISING_EOF = new UnsurprisingEof();
const HIT_MARK_LIMIT = new HitMarkLimit();

function validate(options: CsvSniffOptions): { markLimit: number; minConfidence: number } {
  const markLimit = options.markLimit ?? DEFAULT_CSV_MARK_LIMIT;
  const minConfidence = options.minConfidence ?? DEFAULT_CSV_MIN_CONFIDENCE;
  if (!Number.isInteger(markLimit) || markLimit < 1) {
    throw new RangeError(`markLimit must be a positive integer, got ${markLimit}`);
  }
  if (!Number.isFinite(minConfidence)) {
    throw new RangeError(`minConfidence must be a finite number, got ${minConfidence}`);
  }
  return { markLimit, minConfidence };
}

/** The confidence of every delimiter on the start of `text`, most confident first (ties keep {@link CSV_DELIMITER_NAMES} order). */
export function sniffCsvDelimiters(text: string, options: CsvSniffOptions = {}): CsvSniffResult[] {
  const { markLimit } = validate(options);
  const window = text.length > markLimit ? text.slice(0, markLimit) : text;
  const hasQuote = window.includes('"');
  const results: CsvSniffResult[] = [];
  for (const delimiter of CSV_DELIMITER_NAMES.keys()) {
    // A window with no delimiter and no quote can only make single-column rows: nothing to be confident of.
    const confidence = !hasQuote && !window.includes(delimiter) ? 0 : snifflet(window, markLimit, delimiter);
    results.push({ delimiter, confidence });
  }
  return results.sort((a, b) => b.confidence - a.confidence);
}

/** The delimiter of the table `text` starts as, or null when it is plain text. */
export function bestCsvDelimiter(text: string, options: CsvSniffOptions = {}): string | null {
  const { minConfidence } = validate(options);
  const best = sniffCsvDelimiters(text, options)[0];
  if (best === undefined || best.confidence < minConfidence) return null;
  return best.delimiter;
}

/** Tests one delimiter, with `"` as the quote: Tika's inner class Snifflet. Returns the confidence. */
function snifflet(buf: string, markLimit: number, delimiterChar: string): number {
  const delimiter = delimiterChar.charCodeAt(0);
  const length = buf.length;
  let pos = 0;
  const rowLengthCounts = new Map<number, number>();
  let colCount = 0;
  let rowZero = true;
  let rowZeroEmpty = false;
  let encapsulated = 0;
  let parseException = false;
  let unquotedLen = 0;

  // markLimit - 1, not markLimit: reaching the limit wins over the end of the text at the boundary.
  const read = (): number => {
    if (pos >= markLimit - 1) throw HIT_MARK_LIMIT;
    if (pos >= length) return EOF;
    return buf.charCodeAt(pos++);
  };
  const unread = (c: number): void => {
    if (c !== EOF) pos--;
  };
  const endColumn = (): void => {
    colCount++;
  };
  const endRow = (): void => {
    rowLengthCounts.set(colCount, (rowLengthCounts.get(colCount) ?? 0) + 1);
    if (rowZero && colCount <= 1) rowZeroEmpty = true;
    colCount = 0;
    rowZero = false;
  };
  const consumeSpaceCharacters = (): void => {
    let c = read();
    while (c === SPACE) c = read();
    if (c === EOF) throw UNSURPRISING_EOF;
    unread(c);
  };
  const consumeNewLines = (): void => {
    let c = read();
    while (c === NEW_LINE || c === CARRIAGE_RETURN) c = read();
    if (c === EOF) throw EOF_ERROR;
    unread(c);
  };
  /** True when the quoted cell is closed by a delimiter, a line end or the end of the text (Excel's doubled-quote escape). */
  const consumeQuoted = (): boolean => {
    let c = read();
    while (c !== EOF) {
      if (c === QUOTE) {
        let next = read();
        if (next === EOF) {
          encapsulated++;
          endColumn();
          throw UNSURPRISING_EOF;
        }
        if (next !== QUOTE) {
          encapsulated++;
          endColumn();
          unread(next);
          consumeSpaceCharacters();
          next = read();
          if (next === EOF) throw UNSURPRISING_EOF;
          if (next === NEW_LINE || next === CARRIAGE_RETURN) {
            unread(next);
            return true;
          }
          unread(next);
          return next === delimiter;
        }
      }
      c = read();
    }
    throw EOF_ERROR;
  };

  const confidence = (): number => {
    if (parseException) return -1;
    let max = -1;
    let totalRows = 0;
    for (const [columns, count] of rowLengthCounts) {
      // Needs more than one column: at least one delimiter in the row.
      if (columns > 1 && count > max) max = count;
      totalRows += count;
    }
    let consistency = 0;
    // Too little to go on, or a first row with no delimiter (TIKA-4278): not credible as a table.
    if (max >= 0 && totalRows >= 3 && !rowZeroEmpty) {
      consistency = (1 - 1 / Math.pow(totalRows, 0.3)) * (max / totalRows);
    }
    // Encapsulated cells outweigh inconsistent column counts: a small bonus that approaches 1.
    const bonus = encapsulated > 0 ? 1 - 1 / Math.pow(encapsulated, 0.2) : 0;
    return Math.min(consistency + bonus, 1);
  };

  let eof = false;
  let hitMarkLimit = false;
  let lastC = -1;
  try {
    let c = read();
    while (c !== EOF) {
      if (c === QUOTE) {
        unquotedLen = 0;
        // A quote inside a cell, not at its start.
        if (lastC > -1 && lastC !== delimiter && lastC !== NEW_LINE && lastC !== CARRIAGE_RETURN) {
          parseException = true;
          return confidence();
        }
        if (!consumeQuoted()) {
          parseException = true;
          return confidence();
        }
      } else if (c === delimiter) {
        unquotedLen = 0;
        endColumn();
        consumeSpaceCharacters();
      } else if (c === NEW_LINE || c === CARRIAGE_RETURN) {
        if (unquotedLen > 0) endColumn();
        unquotedLen = 0;
        endRow();
        consumeNewLines();
      } else {
        unquotedLen++;
      }
      lastC = c;
      c = read();
    }
  } catch (error) {
    if (error instanceof HitMarkLimit) hitMarkLimit = true;
    else if (error instanceof UnsurprisingEof) {
      // The text ended where it should have: nothing to note.
    } else if (error instanceof SniffEof) eof = true;
    else throw error;
  }
  // A last row cut off by the mark limit, or by the end of the text mid-structure, is not counted.
  if (!hitMarkLimit && !eof && lastC !== NEW_LINE && lastC !== CARRIAGE_RETURN) {
    unquotedLen = 0;
    endColumn();
    endRow();
  }
  return confidence();
}
