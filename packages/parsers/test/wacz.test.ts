import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import { gzipSync, strToU8, zipSync } from "fflate";
import { WACZParser } from "../src/index.ts";

/*
 * Ported from the case of Tika 4.2.0's WACZParserTest, with archives built here instead of its fixture. The
 * expectations are what WACZParser.java does when read; none of this was run against a Tika.
 */

const WARC_TEXT = "WARC/1.0\r\nWARC-Type: warcinfo\r\nContent-Length: 0\r\n\r\n\r\n\r\n";

function archive(entries: Record<string, string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) files[name] = typeof value === "string" ? strToU8(value) : value;
  return zipSync(files);
}

interface Embedded {
  readonly metadata: Metadata;
  readonly text: string;
  readonly size: number;
}

interface Result {
  readonly metadata: Metadata;
  readonly xml: string;
  readonly embedded: Embedded[];
}

async function run(entries: Record<string, string | Uint8Array>, context = new ParseContext()): Promise<Result> {
  const resources = new EmbeddedDocumentBytesHandler();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const stream = await RipstreamInputStream.from(archive(entries));
  const handler = createOutputHandler("xml");
  const metadata = new Metadata();
  try {
    await new WACZParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return {
    metadata,
    xml: handler.toString(),
    embedded: resources.resources.map((resource) => ({
      metadata: resource.metadata,
      text: new TextDecoder().decode(resource.bytes),
      size: resource.bytes.byteLength,
    })),
  };
}

test("each entry under archive/ is an embedded document named without the folder, with its path in the archive", async () => {
  const result = await run({ "archive/data.warc": WARC_TEXT, "datapackage.json": "{}" });
  assert.equal(result.embedded.length, 1);
  const { metadata, text } = result.embedded[0]!;
  assert.equal(metadata.get("tk:resource-name"), "data.warc");
  assert.equal(metadata.get("tk:internal-path"), "archive/data.warc");
  assert.equal(metadata.get("Content-Length"), String(WARC_TEXT.length));
  assert.equal(text, WARC_TEXT);
});

test("a gzip entry is inflated, and its Content-Length is the size of the entry in the archive", async () => {
  const gz = gzipSync(strToU8(WARC_TEXT));
  const result = await run({ "archive/data.warc.gz": gz });
  const { metadata, text } = result.embedded[0]!;
  assert.equal(text, WARC_TEXT);
  assert.equal(metadata.get("tk:resource-name"), "data.warc.gz");
  assert.equal(metadata.get("Content-Length"), String(gz.byteLength));
});

test("only entries under archive/ are read, in archive order", async () => {
  const result = await run({
    "archive/b.warc": "second-written-first",
    "datapackage.json": '{"profile":"data-package"}',
    "pages/pages.jsonl": '{"format":"json-pages-1.0"}',
    "indexes/index.cdx.gz": gzipSync(strToU8("cdx")),
    "archive/a.warc": "first-written-second",
    "archivefile.warc": "not under archive/",
    "nested/archive/c.warc": "an archive/ folder further down",
  });
  assert.deepEqual(
    result.embedded.map((item) => item.metadata.get("tk:resource-name")),
    ["b.warc", "a.warc"],
  );
});

test("a gzip whose members are one per record gives the first member only, as Tika's reader does", async () => {
  const first = gzipSync(strToU8("record one;"));
  const second = gzipSync(strToU8("record two;"));
  const both = new Uint8Array(first.byteLength + second.byteLength);
  both.set(first, 0);
  both.set(second, first.byteLength);
  const result = await run({ "archive/data.warc.gz": both });
  assert.equal(result.embedded[0]!.text, "record one;");
  assert.equal(result.embedded[0]!.metadata.get("Content-Length"), String(both.byteLength));
});

test("a gzip header with a file name, a comment and an extra field is skipped", async () => {
  const gz = gzipSync(strToU8(WARC_TEXT), { filename: "data.warc", mtime: 1_700_000_000 });
  assert.notEqual(gz[3]! & 0x08, 0, "the file name flag is set");
  const result = await run({ "archive/data.warc.gz": gz });
  assert.equal(result.embedded[0]!.text, WARC_TEXT);

  // Flags set by hand around a header of the same shape: a comment (0x10) and an extra field (0x04).
  const plain = gzipSync(strToU8(WARC_TEXT));
  const header = plain.subarray(0, 10).slice();
  header[3] = 0x04 | 0x10;
  const extra = new Uint8Array([3, 0, 1, 2, 3]);
  const comment = strToU8("a comment\0");
  const custom = new Uint8Array(10 + extra.length + comment.length + plain.length - 10);
  custom.set(header, 0);
  custom.set(extra, 10);
  custom.set(comment, 10 + extra.length);
  custom.set(plain.subarray(10), 10 + extra.length + comment.length);
  const second = await run({ "archive/data.warc.gz": custom });
  assert.equal(second.embedded[0]!.text, WARC_TEXT);
});

test("a gzip header that is cut short, names another method or sets a reserved flag fails the parse", async () => {
  const header = (...bytes: number[]): Uint8Array => new Uint8Array([0x1f, 0x8b, ...bytes]);
  for (const entry of [
    header(0x08, 0x00, 1, 2),
    header(0x07, 0x00, 0, 0, 0, 0, 0, 3, 1, 1, 1),
    header(0x08, 0x20, 0, 0, 0, 0, 0, 3, 1, 1, 1),
    header(0x08, 0x08, 0, 0, 0, 0, 0, 3, 0x6e, 0x61, 0x6d, 0x65),
  ]) {
    await assert.rejects(run({ "archive/a.warc.gz": entry }), MalformedDocumentError);
  }
});

test("an entry that only looks like gzip is recorded on the archive, and the next entry is still read", async () => {
  const result = await run({
    "archive/bad.warc.gz": new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    "archive/good.warc": WARC_TEXT,
  });
  assert.match(result.metadata.get("tk:exception:embedded-stream-exception") ?? "", /./);
  assert.deepEqual(
    result.embedded.map((item) => item.metadata.get("tk:resource-name")),
    ["good.warc"],
  );
});

test("an archive with nothing under archive/ gives an empty document", async () => {
  const result = await run({ "datapackage.json": "{}" });
  assert.equal(result.embedded.length, 0);
  assert.equal(result.metadata.get("tk:exception:embedded-stream-exception"), null);
});

test("supports the one WACZ type", () => {
  assert.deepEqual([...new WACZParser().getSupportedTypes()].map((type) => type.toString()), ["application/x-wacz"]);
});

test("a hostile archive is refused, not expanded: an entry bomb, a gzip bomb, and too many entries", async () => {
  const entryBomb = await RipstreamInputStream.from(
    archive({ "archive/a.warc": new Uint8Array(5_000_000), "archive/b.warc": new Uint8Array(5_000_000) }),
  );
  await assert.rejects(
    new WACZParser().parse(entryBomb, createOutputHandler("xml"), new Metadata(), new ParseContext()),
    LimitExceededError,
  );
  await entryBomb.close();

  // Twenty megabytes of zeros are twenty kilobytes of gzip: a thousand to one, over the limit of a hundred.
  const gzipBomb = await RipstreamInputStream.from(archive({ "archive/a.warc.gz": gzipSync(new Uint8Array(20_000_000)) }));
  await assert.rejects(
    new WACZParser().parse(gzipBomb, createOutputHandler("xml"), new Metadata(), new ParseContext()),
    LimitExceededError,
  );
  await gzipBomb.close();

  const many: Record<string, string> = {};
  for (let index = 0; index < 20; index++) many[`archive/${index}.warc`] = WARC_TEXT;
  const crowded = await RipstreamInputStream.from(archive(many));
  await assert.rejects(
    new WACZParser().parse(
      crowded,
      createOutputHandler("xml"),
      new Metadata(),
      new ParseContext({ limits: { maxZipEntries: 10 } }),
    ),
    LimitExceededError,
  );
  await crowded.close();
});

test("the inflated gzip of all the entries counts against the total limit, not only each one", async () => {
  // Each inflates to 3 MB, under the limit of 8 MB; the ratio limit is lifted so that only the total can refuse them.
  const part = gzipSync(new Uint8Array(3_000_000));
  const entries: Record<string, Uint8Array> = {};
  for (let index = 0; index < 4; index++) entries[`archive/${index}.warc.gz`] = part;
  const stream = await RipstreamInputStream.from(archive(entries));
  await assert.rejects(
    new WACZParser().parse(
      stream,
      createOutputHandler("xml"),
      new Metadata(),
      (() => {
        const context = new ParseContext({ limits: { maxTotalEmbeddedBytes: 8_000_000, maxDecompressionRatio: 100_000 } });
        context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, new EmbeddedDocumentBytesHandler());
        return context;
      })(),
    ),
    LimitExceededError,
  );
  await stream.close();
});

/** The plain gzip of `WARC_TEXT` with a header of the given flags and optional fields in place of its own. */
function gzipWithHeader(flags: number, fields: Uint8Array): Uint8Array {
  const plain = gzipSync(strToU8(WARC_TEXT));
  const header = plain.subarray(0, 10).slice();
  header[3] = flags;
  const out = new Uint8Array(10 + fields.length + plain.length - 10);
  out.set(header, 0);
  out.set(fields, 10);
  out.set(plain.subarray(10), 10 + fields.length);
  return out;
}

test("an extra field alone is skipped by its own length, which is two bytes", async () => {
  for (const length of [3, 300]) {
    const field = new Uint8Array(2 + length);
    field[0] = length & 0xff;
    field[1] = length >> 8;
    field.fill(0x41, 2);
    const result = await run({ "archive/a.warc.gz": gzipWithHeader(0x04, field) });
    assert.equal(result.embedded[0]!.text, WARC_TEXT, `an extra field of ${length} bytes`);
  }
});

test("a header checksum is skipped", async () => {
  const result = await run({ "archive/a.warc.gz": gzipWithHeader(0x02, new Uint8Array([0xde, 0xad])) });
  assert.equal(result.embedded[0]!.text, WARC_TEXT);
});

test("an entry that starts with 0x1f but not 0x8b is not gzip, and is passed on as it is", async () => {
  const raw = new Uint8Array([0x1f, 0x41, 0x42, 0x43]);
  const result = await run({ "archive/a.warc": raw });
  assert.equal(result.embedded[0]!.text, "\x1fABC");
  assert.equal(result.metadata.get("tk:exception:embedded-stream-exception"), null);
});

/** An extractor that offers every entry to nobody and charges nothing: only WACZParser's own accounting can refuse. */
async function parseRefused(
  entries: Record<string, Uint8Array>,
  limits: ConstructorParameters<typeof ParseContext>[0],
): Promise<number> {
  let parsed = 0;
  const extractor: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: () => false,
    parseEmbedded: async () => {
      parsed++;
    },
  };
  const context = new ParseContext(limits);
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(archive(entries));
  try {
    await new WACZParser().parse(stream, createOutputHandler("xml"), new Metadata(), context);
  } finally {
    await stream.close();
  }
  return parsed;
}

test("an entry the extractor does not want is not parsed", async () => {
  assert.equal(await parseRefused({ "archive/a.warc": strToU8(WARC_TEXT) }, undefined), 0);
});

test("the inflated gzip counts against the total even when the extractor takes none of it", async () => {
  const part = gzipSync(new Uint8Array(3_000_000));
  const entries: Record<string, Uint8Array> = {};
  for (let index = 0; index < 4; index++) entries[`archive/${index}.warc.gz`] = part;
  await assert.rejects(
    parseRefused(entries, { limits: { maxTotalEmbeddedBytes: 8_000_000, maxDecompressionRatio: 100_000 } }),
    LimitExceededError,
  );
  // Three of them are 9 MB, which a limit of 9 MB lets through: the total is a limit on more than it.
  delete entries["archive/3.warc.gz"];
  assert.equal(
    await parseRefused(entries, { limits: { maxTotalEmbeddedBytes: 9_000_000, maxDecompressionRatio: 100_000 } }),
    0,
  );
});

test("one entry is held to the limit of one embedded resource, though the total would allow it", async () => {
  const entries = { "archive/a.warc.gz": gzipSync(new Uint8Array(3_000_000)) };
  await assert.rejects(
    parseRefused(entries, {
      limits: { maxEmbeddedResourceBytes: 1_000_000, maxTotalEmbeddedBytes: 8_000_000, maxDecompressionRatio: 100_000 },
    }),
    LimitExceededError,
  );
});

test("a gzip entry that inflates to a hundred times its size or more is refused though it is small", async () => {
  // Three megabytes of zeros are three kilobytes of gzip: under every size limit, over the ratio.
  const entries = { "archive/a.warc.gz": gzipSync(new Uint8Array(3_000_000)) };
  await assert.rejects(parseRefused(entries, undefined), LimitExceededError);
});
