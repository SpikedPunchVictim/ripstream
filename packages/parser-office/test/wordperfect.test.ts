import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { WordPerfectParser } from "../src/index.ts";

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/** A WP 5.1 prefix area and a document area of the given bytes. */
function wp5(text: number[]): Uint8Array {
  const header = [...[... "ÿWPC"].map((c) => c.charCodeAt(0)), ...u32(16), 1, 0x0a, 0, 1, ...u16(0), ...u16(0)];
  return new Uint8Array([...header, ...text]);
}

test("reads WordPerfect 5.1 document-area text", async () => {
  const stream = await RipstreamInputStream.from(wp5([...[...("Hello")].map((c) => c.charCodeAt(0)), 10, ...[...("world")].map((c) => c.charCodeAt(0))]));
  const handler = new BodyContentHandler();
  await new WordPerfectParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  const text = handler.toString();
  assert.match(text, /Hello/);
  assert.match(text, /world/);
});
