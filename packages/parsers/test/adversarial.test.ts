import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  OutputLimitContentHandler,
  ParseContext,
  RipstreamInputStream,
  type Parser,
} from "@spikedpunch/ripstream-core";
import {
  CsvParser,
  DbfParser,
  DicomParser,
  HtmlDocumentParser,
  MarkdownParser,
  TnefParser,
  WarcParser,
} from "../src/index.ts";

const encoder = new TextEncoder();
// The csv comma bomb takes 1.2 s alone, but 6.3 s in one full-suite run beside hundreds of process-spawning tests.
// A quadratic blow-up takes minutes, so the budget only has to separate "linear" from "runaway".
const MAX_MILLIS = 15_000;

async function run(
  parser: Parser,
  bytes: Uint8Array,
): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await parser.parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

async function timed<T>(action: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await action();
  } finally {
    assert.ok(performance.now() - start < MAX_MILLIS, "adversarial input took too long");
  }
}

test("tnef: NUL runs and unclosed script tags parse in linear time", { timeout: 30_000 }, async () => {
  // MS-OXTNEF layout: level, tag (type<<16 | id), length, data, 2-byte checksum.
  const attribute = (tag: number, value: Uint8Array): number[] => {
    const header = new Uint8Array(9);
    const view = new DataView(header.buffer);
    header[0] = 1;
    view.setUint32(1, tag, true);
    view.setUint32(5, value.length, true);
    return [...header, ...value, 0, 0];
  };
  // attMsgProps blob holding a single PT_BINARY PR_BODY_HTML property.
  const htmlProperty = (value: Uint8Array): Uint8Array => {
    const prefix = new Uint8Array(16);
    const view = new DataView(prefix.buffer);
    view.setUint32(0, 1, true); // property count
    view.setUint16(4, 0x0102, true); // PT_BINARY
    view.setUint16(6, 0x1013, true); // PR_BODY_HTML
    view.setUint32(8, 1, true); // value count
    view.setUint32(12, value.length, true);
    const padding = new Uint8Array((4 - (value.length % 4)) % 4);
    return Uint8Array.from([...prefix, ...value, ...padding]);
  };
  const nuls = encoder.encode("\0".repeat(200_000) + "x");
  const html = encoder.encode("<script ".repeat(30_000) + "<b ".repeat(30_000));
  const head = new Uint8Array(6);
  new DataView(head.buffer).setUint32(0, 0x223e9f78, true);
  const data = Uint8Array.from([
    ...head,
    ...attribute(0x00018004, nuls), // attSubject
    ...attribute(0x00069003, htmlProperty(html)), // attMsgProps
  ]);
  await timed(() => run(new TnefParser(), data));
});

test("dicom: long NUL-padded values parse in linear time", { timeout: 30_000 }, async () => {
  const body: number[] = [];
  for (let index = 0; index < 4; index++) {
    const value = encoder.encode("\0".repeat(60_000) + "x");
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint16(0, 0x0008, true);
    view.setUint16(2, 0x1030, true);
    header.set(encoder.encode("UT"), 4);
    view.setUint32(8, value.length, true);
    body.push(...header, ...value);
  }
  const data = new Uint8Array(132 + body.length);
  data.set(encoder.encode("DICM"), 128);
  data.set(body, 132);
  await timed(() => run(new DicomParser(), data));
});

test("markdown: unclosed fences and inline markers parse in linear time", { timeout: 30_000 }, async () => {
  for (const input of ["``` ".repeat(80_000), "**a ".repeat(80_000), "[a](".repeat(80_000)]) {
    await timed(() => run(new MarkdownParser(), encoder.encode(input)));
  }
});

test("markdown: fenced code and inline markup still render", async () => {
  const result = await run(
    new MarkdownParser(),
    encoder.encode("# Title\n\n```js\ncode()\n```\n\nSome **bold** [link](http://x)"),
  );
  assert.match(result.text, /Title/);
  assert.match(result.text, /code\(\)/);
  assert.match(result.text, /Some bold link/);
});

test("html: deeply unclosed tags fail fast with a limit error", { timeout: 30_000 }, async () => {
  await timed(() =>
    assert.rejects(
      run(new HtmlDocumentParser(), encoder.encode("<b>".repeat(300_000))),
      LimitExceededError,
    ),
  );
});

test("csv: an unterminated comma bomb fails fast with a limit error", { timeout: 30_000 }, async () => {
  // #23: 1,000,001 commas form one unterminated row of empty cells. Cells now stream to
  // the handler, so memory is bounded structurally and the output cap (one "\t" charged
  // per cell) stops the bomb after ~maxOutputChars cells. Run with the cap applied, as
  // ripstream.ts does in production, rather than with an uncapped handler.
  const stream = await RipstreamInputStream.from(encoder.encode(",".repeat(1_000_001)));
  const handler = new OutputLimitContentHandler(new BodyContentHandler(), 100_000);
  try {
    await timed(() =>
      assert.rejects(
        new CsvParser().parse(stream, handler, new Metadata(), new ParseContext()),
        LimitExceededError,
      ),
    );
  } finally {
    await stream.close();
  }
});

test("html: large flat documents and stray close tags parse in linear time", { timeout: 30_000 }, async () => {
  await timed(() => run(new HtmlDocumentParser(), encoder.encode("<br>x".repeat(150_000))));
  await timed(() => run(new HtmlDocumentParser(), encoder.encode("</x>".repeat(100_000))));
});

test("dbf: zero-length fields cannot multiply records", { timeout: 30_000 }, async () => {
  const fieldCount = 2000;
  const headerLength = 32 + fieldCount * 32 + 1;
  const records = 30_000;
  const data = new Uint8Array(headerLength + records * 2);
  const view = new DataView(data.buffer);
  data[0] = 0x03;
  view.setUint32(4, records, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, 2, true);
  for (let field = 0; field < fieldCount; field++) {
    const at = 32 + field * 32;
    data.set(encoder.encode("F"), at);
    data[at + 11] = "C".charCodeAt(0);
    data[at + 16] = field === 0 ? 1 : 0;
  }
  data[headerLength - 1] = 0x0d;
  await timed(() => run(new DbfParser(), data));
});

test("dbf: fields beyond the record length are not read", { timeout: 30_000 }, async () => {
  const fieldCount = 2000;
  const headerLength = 32 + fieldCount * 32 + 1;
  const records = 30_000;
  const data = new Uint8Array(headerLength + records * 2);
  const view = new DataView(data.buffer);
  data[0] = 0x03;
  view.setUint32(4, records, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, 2, true);
  for (let field = 0; field < fieldCount; field++) {
    const at = 32 + field * 32;
    data.set(encoder.encode("F"), at);
    data[at + 11] = "C".charCodeAt(0);
    data[at + 16] = 1;
  }
  data[headerLength - 1] = 0x0d;
  await timed(() => run(new DbfParser(), data));
});

test("warc: negative Content-Length is rejected instead of looping", { timeout: 10_000 }, async () => {
  const record = "WARC/1.0\r\nWARC-Type: resource\r\nContent-Length: -4\r\n\r\nbody\r\n\r\n";
  await assert.rejects(
    run(new WarcParser(), encoder.encode(record.repeat(3))),
    MalformedDocumentError,
  );
});
