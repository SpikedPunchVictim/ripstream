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

/** A WP 6 prefix area and a document area of the given bytes. */
function wp6(text: number[]): Uint8Array {
  const bytes = wp5(text);
  bytes[10] = 2;
  return bytes;
}

async function extract(file: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(file);
  const handler = new BodyContentHandler();
  await new WordPerfectParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  return handler.toString();
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

test("WP6 variable-length function with a size below its header does not loop (tikajs-bughunt-wp6)", async () => {
  // 0xD0 subgroup 0x01 size 0: skip(size - 4) used to rewind the cursor onto the same function forever.
  const text = await extract(wp6([...ascii("before"), 0xd0, 0x01, 0x00, 0x00, ...ascii("after")]));
  assert.match(text, /before/);
  assert.match(text, /after/);
});

test("WP6 variable-length function truncated at end of file ends the text", async () => {
  const text = await extract(wp6([...ascii("tail"), 0xd0]));
  assert.match(text, /tail/);
});
