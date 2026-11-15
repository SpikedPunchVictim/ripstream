import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  XHTMLContentHandler,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { ZipParser } from "../src/index.ts";

const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

interface RawEntry {
  readonly name: string;
  readonly method: number;
  readonly compressed: Uint8Array;
  /** What the headers claim, which need not be true. */
  readonly declaredSize: number;
  /** The general purpose flags; bit 0 marks an encrypted entry. */
  readonly flags?: number;
}

/** Stored (method 0) or deflated (8) entry whose headers declare `declaredSize`. */
function entry(name: string, content: Uint8Array, method: 0 | 8 = 8, declaredSize = content.length): RawEntry {
  return { name, method, compressed: method === 8 ? deflateRawSync(content) : content, declaredSize };
}

/** An entry with method 9 whose stream is a single stored block, which Deflate and Deflate64 share. */
function deflate64Entry(name: string, content: Uint8Array): RawEntry {
  const length = content.length;
  const compressed = new Uint8Array([0x01, ...le16(length), ...le16(~length & 0xffff), ...content]);
  return { name, method: 9, compressed, declaredSize: length };
}

function zip(entries: readonly RawEntry[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  for (const raw of entries) {
    const name = [...new TextEncoder().encode(raw.name)];
    const offset = local.length;
    local.push(
      ...le32(0x04034b50), ...le16(20), ...le16(raw.flags ?? 0), ...le16(raw.method), ...le16(0), ...le16(0),
      ...le32(0), ...le32(raw.compressed.length), ...le32(raw.declaredSize), ...le16(name.length), ...le16(0),
      ...name, ...raw.compressed,
    );
    central.push(
      ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(raw.flags ?? 0), ...le16(raw.method), ...le16(0), ...le16(0),
      ...le32(0), ...le32(raw.compressed.length), ...le32(raw.declaredSize), ...le16(name.length), ...le16(0),
      ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name,
    );
  }
  const eocd = [
    ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length),
    ...le32(central.length), ...le32(local.length), ...le16(0),
  ];
  return new Uint8Array([...local, ...central, ...eocd]);
}

/** Records each embedded entry as `name=length`. */
function lister(seen: string[]): Parser {
  return {
    getSupportedTypes: () => new Set(),
    async parse(stream, handler) {
      let text = "";
      for await (const chunk of stream) text += new TextDecoder().decode(chunk.subarray(0, 40));
      seen.push(text);
      const xhtml = new XHTMLContentHandler(handler, new Metadata());
      await xhtml.startDocument();
      await xhtml.endDocument();
    },
  };
}

async function parseZip(bytes: Uint8Array, ctx: ParseContext): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  try {
    await new ZipParser().parse(stream, handler, new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  return handler.toString();
}

test("zip: a deflated entry that lies about its size is bounded when another entry forces the entry-by-entry reader (tikajs-w7n3)", async () => {
  // The Deflate64 entry sends the archive down the reader that used to call inflateSync with no cap.
  const bomb = entry("bomb.bin", new Uint8Array(30 * 1024 * 1024), 8, 100);
  const archive = zip([deflate64Entry("ok.txt", new TextEncoder().encode("fine")), bomb]);
  const ctx = new ParseContext({ limits: { maxEmbeddedResourceBytes: 1_000_000, maxDecompressionRatio: 1e9 } });
  ctx.set(CONTEXT_KEYS.PARSER, lister([]));
  // The cap fires inside the inflate, not in the check after the whole entry is in memory.
  await assert.rejects(parseZip(archive, ctx), (error) => error instanceof LimitExceededError && /Decompressed deflate-raw/.test(error.message));
});

test("zip: entries of the entry-by-entry reader share the archive's total, whatever their headers say (tikajs-w7n3)", async () => {
  const entries = [deflate64Entry("ok.txt", new TextEncoder().encode("fine"))];
  for (let index = 0; index < 5; index++) entries.push(entry(`part${index}.bin`, new Uint8Array(400_000), 8, 10));
  const ctx = new ParseContext({
    limits: { maxEmbeddedResourceBytes: 1_000_000, maxTotalEmbeddedBytes: 1_000_000, maxDecompressionRatio: 1e9 },
  });
  ctx.set(CONTEXT_KEYS.PARSER, lister([]));
  await assert.rejects(parseZip(zip(entries), ctx), (error) => error instanceof LimitExceededError && /Decompressed deflate-raw/.test(error.message));
});

test("zip: an entry named __proto__ and a repeated name are both read (tikajs-gz44)", async () => {
  const seen: string[] = [];
  const archive = zip([
    entry("a.txt", new TextEncoder().encode("first copy")),
    entry("__proto__", new TextEncoder().encode("proto entry")),
    entry("a.txt", new TextEncoder().encode("second copy")),
  ]);
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, lister(seen));
  await parseZip(archive, ctx);
  assert.deepEqual(seen.sort(), ["first copy", "proto entry", "second copy"]);
});

// Oracle (Tika 4.2.0 /rmeta, a zip of a.txt, b.txt, c.txt with b.txt's method set to 14 or 99, or its encryption flag set): the entry is
// recorded on the archive as tk:exception:embedded-stream-exception and listed by name, a.txt and c.txt are read. It used to fail the archive.
async function parseZipWithMetadata(bytes: Uint8Array, seen: string[] = []): Promise<{ text: string; metadata: Metadata }> {
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, lister(seen));
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await new ZipParser().parse(stream, handler, metadata, ctx);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

for (const method of [14, 99]) {
  test(`zip: an entry with unsupported method ${method} is recorded and the other entries are read`, async () => {
    const bytes = new TextEncoder().encode("x");
    const { text, metadata } = await parseZipWithMetadata(
      zip([entry("a.txt", bytes, 0), { name: "b.txt", method, compressed: bytes, declaredSize: 1 }, entry("c.txt", bytes, 0)]),
    );
    assert.deepEqual(metadata.getAll("tk:exception:embedded-stream-exception"), ["TikaException: Can't read archive stream (b.txt)"]);
    assert.match(text, /a\.txt[\s\S]*b\.txt[\s\S]*c\.txt/);
  });
}

test("zip: an encrypted entry is recorded as such and its bytes are not read as content", async () => {
  const bytes = new TextEncoder().encode("ciphertext");
  const seen: string[] = [];
  const { metadata } = await parseZipWithMetadata(zip([entry("a.txt", new TextEncoder().encode("plain"), 0), { ...entry("b.txt", bytes, 0), flags: 1 }]), seen);
  assert.deepEqual(metadata.getAll("tk:exception:embedded-stream-exception"), ["EncryptedDocumentException: stream (b.txt) is encrypted"]);
  assert.deepEqual(seen, ["plain"]);
});

test("zip: a bzip2 entry (method 12) is decoded", async () => {
  const compressed = Uint8Array.from(Buffer.from("QlpoOTFBWSZTWcQxSikAAAGeAAACEAASIVRwIAAiGgBoQNA0B17AN45npJ8XckU4UJDEMUop", "base64"));
  const seen: string[] = [];
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, lister(seen));
  await parseZip(zip([{ name: "z.txt", method: 12, compressed, declaredSize: 16 }]), ctx);
  assert.deepEqual(seen, ["BZIP2-ENTRY-TEXT"]);
});

test("zip: entries are read in archive order, whatever their names (tikajs-0s94)", async () => {
  const text = (value: string, name: string): RawEntry => entry(name, new TextEncoder().encode(value), 0);
  const archive = zip([text("B", "b.txt"), text("two", "2"), text("one", "1"), text("Z", "z")]);
  const all: string[] = [];
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, lister(all));
  await parseZip(archive, ctx);
  assert.deepEqual(all, ["B", "two", "one", "Z"]);
  // Under truncation the entries that are read are the first ones in the archive, not the integer-named ones.
  const first: string[] = [];
  const truncating = new ParseContext({ limits: { maxZipEntries: 3 } });
  truncating.set(CONTEXT_KEYS.TRUNCATE_EMBEDDED_LIMIT, true);
  truncating.set(CONTEXT_KEYS.PARSER, lister(first));
  await parseZip(archive, truncating);
  assert.deepEqual(first, ["B", "two", "one"]);
});
