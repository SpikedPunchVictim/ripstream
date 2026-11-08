import assert from "node:assert/strict";
import { test } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import {
  BodyContentHandler,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  XHTMLContentHandler,
  type ContentHandler,
} from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";
import { CSV_CELL_FLUSH_CHARS, CsvParser, CsvScanner, type CsvEvent } from "../src/csv.ts";

// A forced GC makes heapUsed measure *retained* memory rather than uncollected garbage.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
function retainedHeap(): number {
  gc();
  return process.memoryUsage().heapUsed;
}

const encoder = new TextEncoder();
const MB = 1024 * 1024;
const UNBOUNDED_SCANNER = { maxRowChars: Infinity, maxCellsPerRow: Infinity };

/** Faithful copy of the pre-streaming (buffered) scanner, minus the stopgap caps. */
class ReferenceScanner {
  readonly rows: string[][] = [];
  delimiter = ",";
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private pendingQuote = false;
  private skipLf = false;

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
    if (this.row.length > 1 || this.row[0]?.length !== 0) this.rows.push(this.row);
    this.row = [];
    this.skipLf = false;
  }
}

/** Folds streamed events back into rows, asserting they are well-formed and balanced. */
class EventFolder {
  readonly rows: string[][] = [];
  maxText = 0;
  private row: string[] | null = null;
  private cell: string | null = null;

  accept(events: Iterable<CsvEvent>): void {
    for (const event of events) {
      switch (event.kind) {
        case "startRow":
          assert.equal(this.row, null, "startRow inside an open row");
          this.row = [];
          break;
        case "startCell":
          assert.notEqual(this.row, null, "startCell outside a row");
          assert.equal(this.cell, null, "startCell inside an open cell");
          this.cell = "";
          break;
        case "text":
          assert.notEqual(this.cell, null, "text outside a cell");
          assert.ok(event.text.length > 0, "empty text event");
          this.maxText = Math.max(this.maxText, event.text.length);
          this.cell += event.text;
          break;
        case "endCell":
          assert.notEqual(this.cell, null, "endCell without a cell");
          this.row!.push(this.cell!);
          this.cell = null;
          break;
        case "endRow":
          assert.notEqual(this.row, null, "endRow without a row");
          assert.equal(this.cell, null, "endRow inside an open cell");
          assert.ok(this.row!.length > 0, "row with no cells");
          this.rows.push(this.row!);
          this.row = null;
          break;
      }
    }
  }

  assertClosed(): void {
    assert.equal(this.row, null, "row left open");
    assert.equal(this.cell, null, "cell left open");
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "a", "b", "xyz", "é", "😀", " ", ",", ",", ",", '"', '"', '""', '","', ',"', '",',
  "\n", "\n", "\r\n", "\r", "\n\n", "",
];

function randomInput(random: () => number): string {
  const count = Math.floor(random() * 40);
  let text = "";
  for (let index = 0; index < count; index++) {
    text += TOKENS[Math.floor(random() * TOKENS.length)]!;
  }
  return text;
}

/** Splits at random code point boundaries (the decoder never splits a surrogate pair). */
function randomSplit(text: string, random: () => number): string[] {
  const points = [...text];
  const pieces: string[] = [];
  let current = "";
  for (const point of points) {
    current += point;
    if (random() < 0.3) {
      pieces.push(current);
      current = "";
    }
  }
  pieces.push(current);
  return pieces;
}

function scanChunks(text: string, pieces: readonly string[], delimiter: string): string[][] {
  const scanner = new CsvScanner(UNBOUNDED_SCANNER);
  scanner.setDelimiter(delimiter);
  const folder = new EventFolder();
  for (const piece of pieces) folder.accept(scanner.write(piece));
  folder.accept(scanner.end());
  folder.assertClosed();
  assert.equal(pieces.join(""), text);
  return folder.rows;
}

test("differential fuzz: streaming scanner matches the buffered scanner for every chunking", () => {
  const random = mulberry32(0xc5f);
  for (let iteration = 0; iteration < 4000; iteration++) {
    const text = randomInput(random);
    const delimiter = [",", ",", ";", "\t", "|"][Math.floor(random() * 5)]!;
    const reference = new ReferenceScanner();
    reference.delimiter = delimiter;
    reference.write(text);
    reference.end();

    // Whole input at once, one code point at a time, and a random chunking.
    const chunkings = [[text], [...text], randomSplit(text, random)];
    for (const pieces of chunkings) {
      assert.deepEqual(
        scanChunks(text, pieces, delimiter),
        reference.rows,
        `input ${JSON.stringify(text)} delimiter ${JSON.stringify(delimiter)} chunks ${JSON.stringify(pieces)}`,
      );
    }
  }
});

test("differential fuzz: cells larger than the flush size match and are emitted in pieces", () => {
  const random = mulberry32(0xb16);
  const big = (): string => {
    const length = CSV_CELL_FLUSH_CHARS + Math.floor(random() * 3 * CSV_CELL_FLUSH_CHARS);
    const alphabet = ["a", "😀", ",", "\n", '""', "\r\n", " "];
    let text = "";
    while (text.length < length) text += alphabet[Math.floor(random() * alphabet.length)]!;
    return text;
  };
  for (let iteration = 0; iteration < 12; iteration++) {
    // A quoted cell (so embedded separators survive) plus neighbours, and an unquoted one.
    const text =
      `x,"${big()}",y\n` + `${big().replace(/[,\r\n"]/g, "q")},z\n` + `"${big()}`;
    const reference = new ReferenceScanner();
    reference.write(text);
    reference.end();

    const scanner = new CsvScanner(UNBOUNDED_SCANNER);
    const folder = new EventFolder();
    const pieces = randomSplit(text.slice(0, 5000), random);
    pieces.push(text.slice(5000));
    for (const piece of pieces) folder.accept(scanner.write(piece));
    folder.accept(scanner.end());
    folder.assertClosed();
    assert.deepEqual(folder.rows, reference.rows);
    assert.ok(
      folder.maxText <= CSV_CELL_FLUSH_CHARS + 1, // a flush lands on a code point boundary
      `text piece of ${folder.maxText} exceeds ${CSV_CELL_FLUSH_CHARS}`,
    );
  }
});

async function chunkedStream(
  text: string,
  random: () => number,
): Promise<RipstreamInputStream> {
  const bytes = encoder.encode(text);
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let offset = 0;
    while (offset < bytes.length) {
      const size = 1 + Math.floor(random() * 9);
      yield bytes.subarray(offset, offset + size);
      offset += size;
    }
  }
  return RipstreamInputStream.from(chunks());
}

async function renderReference(rows: readonly string[][]): Promise<string> {
  const body = new BodyContentHandler();
  const xhtml = new XHTMLContentHandler(body, new Metadata());
  await xhtml.startDocument();
  if (rows.length > 0) await xhtml.startElement("table");
  for (const row of rows) {
    await xhtml.startElement("tr");
    for (const cell of row) {
      await xhtml.startElement("td");
      if (cell.length > 0) await xhtml.characters(cell);
      await xhtml.endElement("td");
    }
    await xhtml.endElement("tr");
  }
  if (rows.length > 0) await xhtml.endElement("table");
  await xhtml.endDocument();
  return body.toString();
}

test("differential fuzz: CsvParser output is byte-identical to the buffered rendering", async () => {
  const random = mulberry32(0x7ab);
  // ASCII only so charset detection cannot differ from the reference's decoding; the
  // comma is the only candidate delimiter present, so sniffing always picks it.
  const ascii = ["a", "b", "xyz", " ", ",", ",", '"', '""', '","', "\n", "\r\n", "\r", "\n\n"];
  for (let iteration = 0; iteration < 400; iteration++) {
    let text = "";
    for (let index = 0, count = Math.floor(random() * 40); index < count; index++) {
      text += ascii[Math.floor(random() * ascii.length)]!;
    }
    const reference = new ReferenceScanner();
    reference.write(text);
    reference.end();

    const stream = await chunkedStream(text, random);
    const body = new BodyContentHandler();
    try {
      await new CsvParser().parse(stream, body, new Metadata(), new ParseContext());
    } finally {
      await stream.close();
    }
    assert.equal(body.toString(), await renderReference(reference.rows), JSON.stringify(text));
  }
});

/** Counts structure without retaining content; optionally samples heap usage. */
function counter(sampleEvery = 0): ContentHandler & {
  cells: number;
  rows: number;
  chars: number;
  calls: number;
  maxCall: number;
  peakHeap: number;
} {
  let sampled = 0;
  const state = {
    cells: 0,
    rows: 0,
    chars: 0,
    calls: 0,
    maxCall: 0,
    peakHeap: 0,
    startDocument(): void {},
    endDocument(): void {},
    startElement(_u: string, _l: string, q: string): void {
      if (q === "td") state.cells += 1;
      else if (q === "tr") state.rows += 1;
      if (sampleEvery > 0 && ++sampled % sampleEvery === 0) {
        state.peakHeap = Math.max(state.peakHeap, retainedHeap());
      }
    },
    endElement(): void {},
    characters(_ch: string, _start: number, length: number): void {
      state.chars += length;
      state.calls += 1;
      state.maxCall = Math.max(state.maxCall, length);
      if (sampleEvery > 0 && ++sampled % sampleEvery === 0) {
        state.peakHeap = Math.max(state.peakHeap, retainedHeap());
      }
    },
    ignorableWhitespace(): void {},
  };
  return state;
}

async function* repeated(piece: string, count: number): AsyncGenerator<Uint8Array> {
  const bytes = encoder.encode(piece);
  for (let index = 0; index < count; index++) yield bytes;
}

async function parseCounting(
  parser: CsvParser,
  source: AsyncIterable<Uint8Array>,
  handler: ContentHandler,
): Promise<void> {
  const stream = await RipstreamInputStream.from(source);
  try {
    await parser.parse(stream, handler, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
}

test("blank rows emit nothing; an empty first cell with a non-empty second cell does", async () => {
  const ripstream = createRipstream();
  const blank = await ripstream.parseToString(encoder.encode("\n\r\n\r\r\n\n"), {
    filename: "blank.csv",
  });
  assert.equal(blank.includes("\t"), false);
  assert.equal(blank.trim(), "");

  const quotedEmpty = counter();
  await parseCounting(new CsvParser(), repeated('""\n', 3), quotedEmpty);
  assert.equal(quotedEmpty.rows, 0);

  const leading = counter();
  await parseCounting(new CsvParser(), repeated("\n,x\n\n", 1), leading);
  assert.equal(leading.rows, 1);
  assert.equal(leading.cells, 2);
  assert.equal(leading.chars, 1);

  const onlyDelimiter = counter();
  await parseCounting(new CsvParser(), repeated(",\n", 1), onlyDelimiter);
  assert.equal(onlyDelimiter.rows, 1);
  assert.equal(onlyDelimiter.cells, 2);

  const quoted = counter();
  await parseCounting(new CsvParser(), repeated('"\n"\n', 1), quoted);
  assert.equal(quoted.rows, 1);
  assert.equal(quoted.cells, 1);
  assert.equal(quoted.chars, 1);
});

test("a giant unterminated cell streams in bounded pieces instead of buffering", async () => {
  const total = 3 * MB + 17;
  const handler = counter();
  const parser = new CsvParser({ maxRowChars: total + 1 });
  await parseCounting(parser, repeated("a".repeat(MB + 5), 3), handler);
  assert.equal(handler.rows, 1);
  assert.equal(handler.cells, 1);
  assert.equal(handler.chars, 3 * (MB + 5));
  assert.ok(handler.maxCall <= CSV_CELL_FLUSH_CHARS, `piece of ${handler.maxCall}`);
  assert.ok(handler.calls >= (3 * MB) / CSV_CELL_FLUSH_CHARS);
});

test("an unclosed quote streams too and is closed at end of input", async () => {
  const handler = counter();
  await parseCounting(new CsvParser(), repeated('"' + "b,\n".repeat(100_000), 1), handler);
  assert.equal(handler.rows, 1);
  assert.equal(handler.cells, 1);
  assert.equal(handler.chars, 300_000);
  assert.ok(handler.maxCall <= CSV_CELL_FLUSH_CHARS + 1);
});

test("caps are configurable product limits: a row wider than the default parses once raised", {
  timeout: 120_000,
}, async () => {
  // Just above the 1,000,000-cell default (the default rejection itself is covered by
  // the 1,000,001-comma case in adversarial.test.ts).
  const cells = 1_000_100;
  const handler = counter();
  await parseCounting(
    new CsvParser({ maxCellsPerRow: 2_000_000 }),
    repeated("x,".repeat(50_000), Math.ceil(cells / 50_000)),
    handler,
  );
  assert.equal(handler.rows, 1);
  assert.equal(handler.cells, Math.ceil(cells / 50_000) * 50_000 + 1);
});

test("maxRowChars is configurable in both directions", async () => {
  await assert.rejects(
    parseCounting(new CsvParser({ maxRowChars: 100 }), repeated("a".repeat(101), 1), counter()),
    LimitExceededError,
  );
  const exact = counter();
  await parseCounting(new CsvParser({ maxRowChars: 100 }), repeated("a".repeat(100), 1), exact);
  assert.equal(exact.chars, 100);

  // Above the 10,000,000 default, accepted once raised.
  const longRow = 10_000_001;
  await assert.rejects(
    parseCounting(new CsvParser(), repeated("a".repeat(longRow), 1), counter()),
    LimitExceededError,
  );
  const raised = counter();
  await parseCounting(
    new CsvParser({ maxRowChars: 20_000_000 }),
    repeated("a".repeat(longRow), 1),
    raised,
  );
  assert.equal(raised.chars, longRow);
});

test("maxCellsPerRow is configurable downward and rejects an over-wide row", async () => {
  await assert.rejects(
    parseCounting(new CsvParser({ maxCellsPerRow: 1000 }), repeated(",".repeat(1001), 1), counter()),
    LimitExceededError,
  );
  const exact = counter();
  await parseCounting(new CsvParser({ maxCellsPerRow: 1000 }), repeated(",".repeat(999), 1), exact);
  assert.equal(exact.cells, 1000);
});

test("invalid cap options are rejected at construction", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new CsvParser({ maxRowChars: bad }), RangeError);
    assert.throws(() => new CsvParser({ maxCellsPerRow: bad }), RangeError);
  }
});

test("a comma bomb is stopped by the output cap, not by buffering", async () => {
  const ripstream = createRipstream({ csv: { maxCellsPerRow: 100_000_000 } });
  const handler = counter();
  await assert.rejects(
    ripstream.parseToHandler(encoder.encode(",".repeat(5 * MB)), handler, {
      filename: "bomb.csv",
      limits: { maxOutputChars: 100_000 },
    }),
    (error: unknown) => error instanceof LimitExceededError && /Output exceeds/.test(error.message),
  );
  // One "\t" is charged per cell, so the cap fires after ~maxOutputChars cells.
  assert.ok(handler.cells <= 100_000, `${handler.cells} cells reached the handler`);
  assert.ok(handler.cells >= 99_900, `${handler.cells} cells reached the handler`);
});

test("a newline-free body stops at the output cap with bounded heap and work", async () => {
  const ripstream = createRipstream({ csv: { maxRowChars: 1_000_000_000 } });
  const handler = counter();
  const before = retainedHeap();
  await assert.rejects(
    ripstream.parseToHandler(encoder.encode("a".repeat(32 * MB)), handler, {
      filename: "line.csv",
      limits: { maxOutputChars: 100_000 },
    }),
    LimitExceededError,
  );
  assert.ok(handler.chars <= 100_000, `${handler.chars} chars reached the handler`);
  assert.ok(handler.maxCall <= CSV_CELL_FLUSH_CHARS + 1);
  // The buffered scanner held ~9x the input (>280 MB for 32 MB).
  assert.ok(retainedHeap() - before < 32 * MB);
});

test("unbounded output (-1) streams a newline-free body with flat heap", {
  timeout: 120_000,
}, async () => {
  const ripstream = createRipstream({ csv: { maxRowChars: 1_000_000_000 } });
  const handler = counter(32);
  const piece = "abcdefgh".repeat(128 * 1024); // 1 MiB
  const count = 48;
  const before = retainedHeap();
  await ripstream.parseToHandler(
    { [Symbol.asyncIterator]: () => repeated(piece, count) } as AsyncIterable<Uint8Array>,
    handler,
    { filename: "huge-line.csv", limits: { maxOutputChars: -1 } },
  );
  assert.equal(handler.chars, piece.length * count);
  assert.equal(handler.cells, 1);
  const growth = handler.peakHeap - before;
  assert.ok(growth < 32 * MB, `heap grew ${(growth / MB).toFixed(1)} MB for ${count} MiB`);
});

test("unbounded output (-1) streams a multi-row table with ~1x memory", {
  timeout: 120_000,
}, async () => {
  const ripstream = createRipstream();
  const handler = counter(1000);
  const field = "x".repeat(1000);
  const piece = `${field},${field},${field}\n`.repeat(1300); // ~3.9 MB
  const pieces = 6;
  const before = retainedHeap();
  await ripstream.parseToHandler(
    { [Symbol.asyncIterator]: () => repeated(piece, pieces) } as AsyncIterable<Uint8Array>,
    handler,
    { filename: "table.csv", limits: { maxOutputChars: -1 } },
  );
  assert.equal(handler.rows, 1300 * pieces);
  assert.equal(handler.cells, 1300 * pieces * 3);
  assert.equal(handler.chars, 1300 * pieces * 3000);
  const growth = handler.peakHeap - before;
  assert.ok(growth < 32 * MB, `heap grew ${(growth / MB).toFixed(1)} MB for ${(pieces * piece.length / MB).toFixed(0)} MB`);
});
