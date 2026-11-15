import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  WriteLimitReachedError,
  XHTMLContentHandler,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { pack } from "tar-stream";
import { TarParser } from "../src/index.ts";

async function makeTar(files: Record<string, string>): Promise<Uint8Array> {
  const archive = pack();
  const chunks: Uint8Array[] = [];
  archive.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => archive.on("end", resolve));
  for (const [name, content] of Object.entries(files)) {
    archive.entry({ name }, content);
  }
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function parseTar(
  files: Record<string, string>,
  ctx: ParseContext,
  handler = new BodyContentHandler(),
): Promise<string> {
  const stream = await RipstreamInputStream.from(await makeTar(files));
  try {
    await new TarParser().parse(stream, handler, new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  return handler.toString();
}

test("tar: per-entry limit rejects and skips remaining entries", { timeout: 10_000 }, async () => {
  const handler = new BodyContentHandler();
  await assert.rejects(
    parseTar(
      { "a.txt": "x".repeat(100), "b.txt": "second", "c.txt": "third" },
      new ParseContext({ limits: { maxEmbeddedResourceBytes: 10 } }),
      handler,
    ),
    LimitExceededError,
  );
  assert.doesNotMatch(handler.toString(), /b\.txt|c\.txt/);
});

test("tar: entry count limit rejects without hanging", { timeout: 10_000 }, async () => {
  await assert.rejects(
    parseTar(
      { "a.txt": "1", "b.txt": "2", "c.txt": "3" },
      new ParseContext({ limits: { maxZipEntries: 1 } }),
    ),
    LimitExceededError,
  );
});

test("tar: handler error in an entry rejects the parse once", { timeout: 10_000 }, async () => {
  class Boom extends BodyContentHandler {
    override async characters(ch: string, start: number, length: number): Promise<void> {
      if (ch === "boom.txt") throw new Error("handler exploded");
      await super.characters(ch, start, length);
    }
  }
  await assert.rejects(
    parseTar({ "boom.txt": "x", "next.txt": "y" }, new ParseContext(), new Boom()),
    /handler exploded/,
  );
});

test("tar: an entry named with an absolute, .. or drive-letter path is read under a sanitised name and recorded, as the ZIP reader does (tikajs-bsv0)", async () => {
  const archive = await makeTar({ "ok.txt": "visible", "/abs/secret.txt": "SECRET-ABS", "../up.txt": "SECRET-UP", "C:evil.txt": "SECRET-DRIVE" });
  const metadata = new Metadata();
  const handler = new BodyContentHandler();
  const stream = await RipstreamInputStream.from(archive);
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, {
    getSupportedTypes: () => new Set(),
    async parse(input, out) {
      const xhtml = new XHTMLContentHandler(out, new Metadata());
      await xhtml.startDocument();
      let text = "";
      for await (const chunk of input) text += new TextDecoder().decode(chunk);
      await xhtml.element("p", text);
      await xhtml.endDocument();
    },
  } satisfies Parser);
  try {
    await new TarParser().parse(stream, handler, metadata, ctx);
  } finally {
    await stream.close();
  }
  assert.match(handler.toString(), /ok\.txt/);
  assert.match(handler.toString(), /SECRET-ABS/);
  assert.match(handler.toString(), /SECRET-UP/);
  assert.match(handler.toString(), /SECRET-DRIVE/);
  const recorded = metadata.getAll("tk:exception:embedded-stream-exception");
  assert.deepEqual(recorded, [
    "unsafe archive path renamed: /abs/secret.txt as abs/secret.txt",
    "unsafe archive path renamed: ../up.txt as up.txt",
    "unsafe archive path renamed: C:evil.txt as evil.txt",
  ]);
});

test("tar: an unsafe directory entry is not an embedded document and is not recorded (tikajs-bsv0)", async () => {
  const archive = pack();
  const chunks: Uint8Array[] = [];
  archive.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => archive.on("end", resolve));
  archive.entry({ name: "../dir/", type: "directory" });
  archive.finalize();
  await done;
  const metadata = new Metadata();
  const stream = await RipstreamInputStream.from(Buffer.concat(chunks));
  try {
    await new TarParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  assert.deepEqual(metadata.getAll("tk:exception:embedded-stream-exception"), []);
});

test("tar: unsafe entries count against maxZipEntries as before (tikajs-bsv0)", async () => {
  const files = { "a.txt": "1", "../b.txt": "2", "/c.txt": "3" };
  const context = (maxZipEntries: number): ParseContext => {
    const ctx = new ParseContext({ limits: { maxZipEntries } });
    ctx.set(CONTEXT_KEYS.PARSER, { getSupportedTypes: () => new Set(), async parse() {} } satisfies Parser);
    return ctx;
  };
  await assert.rejects(parseTar(files, context(2)), LimitExceededError);
  await parseTar(files, context(3));
});

test("tar: a member the output limit cuts is not recorded as a failed embedded document (tikajs-qhmb)", async () => {
  const archive = await makeTar({ "a.txt": "first", "b.txt": "second" });
  const metadata = new Metadata();
  const stream = await RipstreamInputStream.from(archive);
  const ctx = new ParseContext();
  ctx.set(CONTEXT_KEYS.PARSER, {
    getSupportedTypes: () => new Set(),
    async parse() {
      throw new WriteLimitReachedError(40);
    },
  } satisfies Parser);
  try {
    await assert.rejects(new TarParser().parse(stream, new BodyContentHandler(), metadata, ctx), WriteLimitReachedError);
  } finally {
    await stream.close();
  }
  assert.deepEqual(metadata.getAll("tk:exception:embedded-exception"), []);
});
