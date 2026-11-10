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
import { safeEntryName } from "../src/util.ts";

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

test("skips entries that escape the archive root", async () => {
  const result = await parseZip({
    "good.txt": strToU8("safe content"),
    "../../evil.txt": strToU8("evil content"),
  });
  assert.match(result.text, /safe content/);
  assert.doesNotMatch(result.text, /evil content/);
  assert.ok(
    result.metadata
      .getAll("tk:exception:embedded-stream-exception")
      .some((value) => value.includes("evil")),
  );
});

test("rejects zip bombs by decompression ratio", async () => {
  const bomb = new Uint8Array(2 * 1024 * 1024);
  await assert.rejects(parseZip({ "bomb.txt": bomb }), LimitExceededError);
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
