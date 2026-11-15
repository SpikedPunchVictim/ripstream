import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type MediaType,
  type Parser,
  XHTMLContentHandler,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { ZipParser } from "../src/index.ts";
import { EntryNames, safeEntryName, sanitiseEntryName } from "../src/util.ts";

const plainTextParser: Parser = {
  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set();
  },
  async parse(stream, handler): Promise<void> {
    let text = "";
    for await (const chunk of stream) {
      text += new TextDecoder().decode(chunk);
    }
    const xhtml = new XHTMLContentHandler(handler, new Metadata());
    await xhtml.startDocument();
    await xhtml.element("p", text);
    await xhtml.endDocument();
  },
};

async function parseZip(files: Record<string, Uint8Array>): Promise<{
  text: string;
  metadata: Metadata;
}> {
  const stream = await RipstreamInputStream.from(zipSync(files));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, plainTextParser);
  await new ZipParser().parse(stream, handler, metadata, ctx);
  await stream.close();
  return { text: handler.toString(), metadata };
}

test("normalizes safe paths and rejects escaping paths", () => {
  assert.equal(safeEntryName("a/b.txt"), "a/b.txt");
  assert.equal(safeEntryName("a/../b.txt"), "b.txt");
  assert.equal(safeEntryName("../../etc/passwd"), null);
  assert.equal(safeEntryName("/etc/passwd"), null);
  assert.equal(safeEntryName("C:\\windows\\system32"), null);
  assert.equal(safeEntryName("../a/../../b"), null);
});

test("reads an entry that escapes the archive root under a sanitised name and records the rewrite (tikajs-bsv0)", async () => {
  const result = await parseZip({
    "good.txt": strToU8("safe content"),
    "../../evil.txt": strToU8("evil content"),
  });
  assert.match(result.text, /safe content/);
  assert.match(result.text, /evil content/);
  assert.deepEqual(result.metadata.getAll("tk:exception:embedded-stream-exception"), [
    "unsafe archive path renamed: ../../evil.txt as evil.txt",
  ]);
});

test("sanitises absolute, drive, backslash and interior .. names; nothing is left of a bare .. (tikajs-bsv0)", () => {
  assert.equal(sanitiseEntryName("/abs/secret.txt"), "abs/secret.txt");
  assert.equal(sanitiseEntryName("../up.txt"), "up.txt");
  assert.equal(sanitiseEntryName("C:evil.txt"), "evil.txt");
  assert.equal(sanitiseEntryName("C:\\win\\..\\..\\x.txt"), "x.txt");
  assert.equal(sanitiseEntryName("a/../../b.txt"), "b.txt");
  assert.equal(sanitiseEntryName(".."), "unnamed");
  assert.equal(sanitiseEntryName("/"), "unnamed");
});

test("a sanitised name never replaces another entry's name, and a safe name is never changed (tikajs-bsv0)", () => {
  const names = new EntryNames();
  assert.deepEqual(names.resolve("up.txt"), { name: "up.txt" });
  assert.deepEqual(names.resolve("../up.txt"), { name: "up~2.txt", original: "../up.txt" });
  assert.deepEqual(names.resolve("/up.txt"), { name: "up~3.txt", original: "/up.txt" });
  assert.deepEqual(names.resolve("a/./b"), { name: "a/./b" });
  assert.deepEqual(names.resolve("../d/noext"), { name: "d/noext", original: "../d/noext" });
  assert.deepEqual(names.resolve("../d/noext"), { name: "d/noext~2", original: "../d/noext" });
});

test("a zip's later safe name keeps its name and the rewrite avoids it (tikajs-bsv0)", async () => {
  const result = await parseZip({ "../x.txt": strToU8("rewritten"), "x.txt": strToU8("plain") });
  assert.deepEqual(result.metadata.getAll("tk:exception:embedded-stream-exception"), [
    "unsafe archive path renamed: ../x.txt as x~2.txt",
  ]);
});

test("unsafe entries count against maxZipEntries as before (tikajs-bsv0)", async () => {
  const files = { "a.txt": strToU8("a"), "../b.txt": strToU8("b"), "/c.txt": strToU8("c") };
  const parse = async (maxZipEntries: number): Promise<void> => {
    const stream = await RipstreamInputStream.from(zipSync(files));
    const ctx = new ParseContext({ limits: { maxZipEntries } });
    ctx.set(CONTEXT_KEYS.PARSER, plainTextParser);
    try {
      await new ZipParser().parse(stream, new BodyContentHandler(), new Metadata(), ctx);
    } finally {
      await stream.close();
    }
  };
  await assert.rejects(parse(2), LimitExceededError);
  await parse(3);
});

test("rejects zip bombs by decompression ratio", async () => {
  const bomb = new Uint8Array(2 * 1024 * 1024);
  await assert.rejects(parseZip({ "bomb.txt": bomb }), LimitExceededError);
});

test("accepts a highly compressible entry below Tika's zip-bomb output threshold", async () => {
  // Tika's SecureContentHandler checks its ratio only once the output passes OutputLimits.zipBombThreshold
  // (1,000,000), "to avoid false positives" on a document that starts with a highly compressible run. A blank
  // 24-bit bitmap is such an entry: it deflates far past the ratio limit and is harmless. Read from Tika source.
  const blank = new Uint8Array(500_000).fill(0x61);
  const result = await parseZip({ "blank.bmp": blank });
  assert.equal(result.text.length > 500_000, true);
});

test("applies the decompression ratio to an entry just above the threshold, not at it", async () => {
  await parseZip({ "at.bin": new Uint8Array(1_000_000).fill(0x61) });
  await assert.rejects(parseZip({ "above.bin": new Uint8Array(1_000_001).fill(0x61) }), LimitExceededError);
});

test("rejects archives above the embedded resource limit", async () => {
  const stream = await RipstreamInputStream.from(
    zipSync({ "a.txt": strToU8("a"), "b.txt": strToU8("b") }),
  );
  const ctx = new ParseContext({ limits: { maxEmbeddedResources: 1 } });
  ctx.set(CONTEXT_KEYS.PARSER, plainTextParser);
  await assert.rejects(
    new ZipParser().parse(
      stream,
      new BodyContentHandler(),
      new Metadata(),
      ctx,
    ),
    LimitExceededError,
  );
  await stream.close();
});

test("rejects archives above the entry-count limit", async () => {
  const files: Record<string, Uint8Array> = {};
  for (let index = 0; index < 5; index++) {
    files[`f${index}.txt`] = strToU8("x");
  }
  const stream = await RipstreamInputStream.from(zipSync(files));
  await assert.rejects(
    new ZipParser().parse(
      stream,
      new BodyContentHandler(),
      new Metadata(),
      new ParseContext({ limits: { maxZipEntries: 2 } }),
    ),
    LimitExceededError,
  );
  await stream.close();
});
