import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { TnefParser } from "../src/index.ts";

function attr(tag: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [1, ...u32(tag), ...u32(bytes.length), ...bytes];
}
function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

test("extracts TNEF subject and body", async () => {
  const bytes = new Uint8Array([
    ...u32(0x223e9f78), 0x78, 0x9f,
    ...attr(0x8004, "TNEF subject"),
    ...attr(0x800c, "Body line"),
  ]);
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new TnefParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("dc:title"), "TNEF subject");
  assert.match(handler.toString(), /Body line/);
});
