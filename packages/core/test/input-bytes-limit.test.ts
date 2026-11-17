import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  AttributesImpl,
  LimitExceededError,
  MediaType,
  Ripstream,
  type ContentHandler,
  type Detector,
  type InputSource,
  type Parser,
} from "../src/index.ts";

/** tikajs-is31: `ParseLimits.maxInputBytes` is a per-parse cap on the input, checked where the size is known, and while reading where it is not. */

const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };
const scratch = await mkdtemp(join(tmpdir(), "ripstream-input-bytes-"));
after(() => rm(scratch, { recursive: true, force: true }));

function makeRipstream(options: { limits?: { maxInputBytes: number } } = {}): { ripstream: Ripstream; parsed: () => number } {
  let parsed = 0;
  const parser: Parser = {
    name: "Drain",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(stream, handler: ContentHandler): Promise<void> {
      parsed += 1;
      let length = 0;
      for await (const chunk of stream) length += chunk.byteLength;
      await handler.startElement?.("", "body", "body", new AttributesImpl([]));
      await handler.characters?.(String(length), 0, String(length).length);
      await handler.endElement?.("", "body", "body");
    },
  };
  return { ripstream: new Ripstream({ detector, parser, ...options }), parsed: () => parsed };
}

function* chunked(total: number, size: number): Generator<Uint8Array> {
  for (let sent = 0; sent < total; sent += size) yield new Uint8Array(Math.min(size, total - sent));
}

function refusal(observed: number, max: number): (error: unknown) => boolean {
  return (error) =>
    error instanceof LimitExceededError && error.limit === "inputBytes" && error.observed === observed && error.max === max;
}

test("bytes over the cap are refused with the typed error, before any parser runs", async () => {
  const { ripstream, parsed } = makeRipstream();
  await assert.rejects(ripstream.parse(new Uint8Array(11), { limits: { maxInputBytes: 10 } }), refusal(11, 10));
  await assert.rejects(ripstream.parseRecursive(new Uint8Array(11), { limits: { maxInputBytes: 10 } }), refusal(11, 10));
  assert.equal(parsed(), 0);
});

test("an input of exactly the cap is accepted, and so is any input when no cap is set", async () => {
  const { ripstream } = makeRipstream();
  assert.equal((await ripstream.parse(new Uint8Array(10), { limits: { maxInputBytes: 10 } })).text, "10");
  assert.equal((await ripstream.parse(new Uint8Array(5000))).text, "5000");
});

test("an ArrayBuffer, a Blob and a { path } are measured up front", async () => {
  const { ripstream, parsed } = makeRipstream();
  const path = join(scratch, "eleven.bin");
  await writeFile(path, new Uint8Array(11));
  const sources: InputSource[] = [new ArrayBuffer(11), new Blob([new Uint8Array(11)]), { path }];
  for (const source of sources) {
    await assert.rejects(ripstream.parse(source, { limits: { maxInputBytes: 10 } }), refusal(11, 10));
  }
  assert.equal(parsed(), 0);
});

test("a stream of unknown length is refused as soon as it passes the cap, without being read to its end", async () => {
  const { ripstream } = makeRipstream();
  let pulled = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunked(1_000_000, 4)) {
      pulled += 1;
      yield chunk;
    }
  }
  await assert.rejects(ripstream.parse(source(), { limits: { maxInputBytes: 10 } }), refusal(12, 10));
  assert.ok(pulled <= 4, `read ${pulled} chunks`);
  async function* exact(): AsyncGenerator<Uint8Array> {
    yield* chunked(10, 4);
  }
  assert.equal((await ripstream.parse(exact(), { limits: { maxInputBytes: 10 } })).text, "10");
});

test("the ripstream's own limits carry it, and a call's limit wins", async () => {
  const { ripstream } = makeRipstream({ limits: { maxInputBytes: 10 } });
  await assert.rejects(ripstream.parse(new Uint8Array(11)), refusal(11, 10));
  assert.equal((await ripstream.parse(new Uint8Array(11), { limits: { maxInputBytes: 11 } })).text, "11");
});
