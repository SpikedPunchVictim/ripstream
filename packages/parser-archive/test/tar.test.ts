import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
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
