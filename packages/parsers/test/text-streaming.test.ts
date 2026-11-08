import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  Metadata,
  OutputLimitContentHandler,
  ParseContext,
  RipstreamInputStream,
  type ContentHandler,
} from "@spikedpunch/ripstream-core";
import { TextParser } from "../src/text.ts";

const encoder = new TextEncoder();

/** Flat `<p>`/text trace; adjacent characters() calls are merged. */
function tracer(): ContentHandler & { trace: string; calls: number; maxCall: number } {
  const t = {
    trace: "",
    calls: 0,
    maxCall: 0,
    startDocument(): void {},
    endDocument(): void {},
    startElement(_u: string, _l: string, q: string): void {
      if (q === "p") t.trace += "<p>";
    },
    endElement(_u: string, _l: string, q: string): void {
      if (q === "p") t.trace += "</p>";
    },
    characters(ch: string, start: number, length: number): void {
      t.calls += 1;
      t.maxCall = Math.max(t.maxCall, length);
      t.trace += JSON.stringify(ch.slice(start, start + length)).slice(1, -1);
    },
  };
  return t;
}

async function parseChunks(chunks: readonly string[], handler: ContentHandler): Promise<void> {
  async function* bytes(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield encoder.encode(chunk);
  }
  const stream = await RipstreamInputStream.from(bytes());
  try {
    await new TextParser().parse(stream, handler, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
}

async function traceOf(chunks: readonly string[]): Promise<string> {
  const handler = tracer();
  await parseChunks(chunks, handler);
  // Strip the "\n" that the XHTML handler appends after each </p>.
  return handler.trace.replaceAll("</p>\\n", "</p>");
}

const cases: ReadonlyArray<readonly [string, readonly string[], string]> = [
  ["empty file", [], "<p></p>"],
  ["single empty chunk", [""], "<p></p>"],
  ["no terminator", ["abc"], "<p>abc</p>"],
  ["LF", ["a\nb"], "<p>a</p><p>b</p>"],
  ["CRLF", ["a\r\nb"], "<p>a</p><p>b</p>"],
  ["CR", ["a\rb"], "<p>a</p><p>b</p>"],
  ["mixed terminators", ["a\r\nb\rc\nd"], "<p>a</p><p>b</p><p>c</p><p>d</p>"],
  ["blank lines", ["a\n\n\nb"], "<p>a</p><p></p><p></p><p>b</p>"],
  ["CRCR LF", ["a\r\r\nb"], "<p>a</p><p></p><p>b</p>"],
  ["trailing LF", ["a\nb\n"], "<p>a</p><p>b</p><p></p>"],
  ["trailing CRLF", ["a\r\n"], "<p>a</p><p></p>"],
  ["lone trailing CR", ["a\r"], "<p>a</p><p></p>"],
  ["only newline", ["\n"], "<p></p><p></p>"],
  ["CRLF split across chunks", ["a\r", "\nb"], "<p>a</p><p>b</p>"],
  ["CR then non-LF across chunks", ["a\r", "b"], "<p>a</p><p>b</p>"],
  ["CR held across an empty chunk", ["a\r", "", "\nb"], "<p>a</p><p>b</p>"],
  ["line spanning chunks", ["he", "ll", "o\nwor", "ld"], "<p>hello</p><p>world</p>"],
  ["trailing CR in its own final chunk", ["a\nb", "\r"], "<p>a</p><p>b</p><p></p>"],
];

for (const [name, chunks, expected] of cases) {
  test(`text parser output is unchanged: ${name}`, async () => {
    assert.equal(await traceOf(chunks), expected);
  });
}

test("text parser decodes a multibyte character split across chunks inside a line", async () => {
  const bytes = encoder.encode("é\nü");
  async function* split(): AsyncGenerator<Uint8Array> {
    yield bytes.slice(0, 1);
    yield bytes.slice(1);
  }
  const handler = tracer();
  const stream = await RipstreamInputStream.from(split());
  await new TextParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.equal(handler.trace.replaceAll("</p>\\n", "</p>"), "<p>é</p><p>ü</p>");
});

const MB = 1024 * 1024;

test("a newline-free body hits the output cap mid-line without reading the whole input", async () => {
  const chunk = encoder.encode("a".repeat(64 * 1024));
  const total = 800; // ~50 MB
  let pulled = 0;
  async function* body(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < total; i++) {
      pulled += 1;
      yield chunk;
    }
  }
  const stream = await RipstreamInputStream.from(body());
  const limited = new OutputLimitContentHandler(tracer(), MB);
  await assert.rejects(
    new TextParser().parse(stream, limited, new Metadata(), new ParseContext()),
    LimitExceededError,
  );
  await stream.close();
  // 1 MiB cap / 64 KiB chunks = 16 chunks; allow read-ahead slack but far below 800.
  assert.ok(pulled < 64, `pulled ${pulled} of ${total} chunks`);
});

test("a newline-free body is emitted incrementally, not as one line-sized piece", async () => {
  const handler = tracer();
  const piece = "b".repeat(64 * 1024);
  const pieces = 64; // 4 MiB
  await parseChunks(Array.from({ length: pieces }, () => piece), handler);
  assert.ok(handler.calls >= pieces, `characters() called ${handler.calls} times`);
  assert.ok(handler.maxCall <= piece.length, `largest call was ${handler.maxCall}`);
});
