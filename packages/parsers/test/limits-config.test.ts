import assert from "node:assert/strict";
import { test } from "node:test";
import { pack } from "tar-stream";
import { LimitExceededError, loadConfig } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

/*
 * A `parse-context` section sets limits (see core/test/parse-context-config.test.ts for what it may say).
 * `createRipstream({ config })` makes them the defaults of every parse; a limit a call names itself wins.
 */

const encoder = new TextEncoder();

async function tar(entries: Array<{ name: string; data: string | Uint8Array }>): Promise<Uint8Array> {
  const archive = pack();
  for (const entry of entries) {
    archive.entry({ name: entry.name }, typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data);
  }
  archive.finalize();
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const configured = (parseContext: unknown) => createRipstream({ config: loadConfig({ "parse-context": parseContext }) });
const THREE = (): Promise<Uint8Array> => tar([{ name: "a.txt", data: "one" }, { name: "b.txt", data: "two" }, { name: "c.txt", data: "three" }]);

test("writeLimit sets the output limit of every parse, and fails at it as ripstream does", async () => {
  // The count includes the whitespace the output carries between elements, so the limit leaves room for a short text.
  const ripstream = configured({ "output-limits": { writeLimit: 50, throwOnWriteLimit: true } });
  const long = encoder.encode("word ".repeat(100));
  await assert.rejects(ripstream.parse(long, { filename: "a.txt" }), (error: unknown) => error instanceof LimitExceededError && /Output exceeds 50 characters/.test(error.message));
  assert.equal((await ripstream.parse(encoder.encode("Hi"), { filename: "a.txt" })).text.trim(), "Hi");
  // Without the section the same document parses.
  assert.match((await createRipstream().parse(long, { filename: "a.txt" })).text, /word word/);
});

test("a limit the call names itself wins over the configuration's", async () => {
  const ripstream = configured({ "output-limits": { writeLimit: 5, throwOnWriteLimit: true } });
  await assert.rejects(ripstream.parse(encoder.encode("Hello there, world"), { filename: "a.txt" }), LimitExceededError);
  const result = await ripstream.parse(encoder.encode("Hello there, world"), { filename: "a.txt", limits: { maxOutputChars: 1000 } });
  assert.match(result.text, /Hello there, world/);
  // A limit set to undefined names none: the configuration's still applies.
  await assert.rejects(ripstream.parse(encoder.encode("Hello there, world"), { filename: "a.txt", limits: { maxOutputChars: undefined } }), LimitExceededError);
});

test("maxCount: the Nth embedded document is parsed and the N+1st is refused", async () => {
  const archive = await THREE();
  const two = configured({ "embedded-limits": { maxCount: 2, throwOnMaxCount: true } });
  await assert.rejects(two.parse(archive, { filename: "x.tar" }), (error: unknown) => error instanceof LimitExceededError && /Embedded count 3 exceeds 2/.test(error.message));
  const three = configured({ "embedded-limits": { maxCount: 3, throwOnMaxCount: true } });
  assert.match((await three.parse(archive, { filename: "x.tar" })).text, /three/);
});

test("parseRecursive and parseToStream use the same defaults", async () => {
  const archive = await THREE();
  const two = configured({ "embedded-limits": { maxCount: 2, throwOnMaxCount: true } });
  await assert.rejects(two.parseRecursive(archive, { filename: "x.tar" }), LimitExceededError);
  const stream = two.parseToStream(archive, { filename: "x.tar" });
  await assert.rejects(async () => {
    for await (const _chunk of stream as unknown as AsyncIterable<Uint8Array>) void _chunk;
  }, LimitExceededError);
});

test("maxDepth: a child deeper than N is refused", async () => {
  const inner = await tar([{ name: "deep.txt", data: "deepest" }]);
  const outer = await tar([{ name: "inner.tar", data: inner }]);
  const one = configured({ "embedded-limits": { maxDepth: 1, throwOnMaxDepth: true } });
  await assert.rejects(one.parse(outer, { filename: "x.tar" }), (error: unknown) => error instanceof LimitExceededError && /Embedded depth 2 exceeds 1/.test(error.message));
  const two = configured({ "embedded-limits": { maxDepth: 2, throwOnMaxDepth: true } });
  assert.match((await two.parse(outer, { filename: "x.tar" })).text, /deepest/);
});

test("the limits option sets defaults too, and beats the configuration's", async () => {
  const archive = await THREE();
  const config = loadConfig({ "parse-context": { "embedded-limits": { maxCount: 1, throwOnMaxCount: true } } });
  await assert.rejects(createRipstream({ config }).parse(archive, { filename: "x.tar" }), LimitExceededError);
  assert.match((await createRipstream({ config, limits: { maxEmbeddedResources: 10 } }).parse(archive, { filename: "x.tar" })).text, /three/);
  await assert.rejects(createRipstream({ limits: { maxEmbeddedResources: 2 } }).parse(archive, { filename: "x.tar" }), LimitExceededError);
});

test("an invalid limits option is refused when the ripstream is built, not at the first parse", () => {
  assert.throws(() => createRipstream({ limits: { maxEmbeddedResources: -5 } }), RangeError);
  assert.throws(() => createRipstream({ limits: { maxBogus: 1 } as never }), RangeError);
});
