import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { ImageParser } from "../src/index.ts";

function sampleJpeg(): Uint8Array {
  const comment = new TextEncoder().encode("A JPEG comment");
  const bytes: number[] = [0xff, 0xd8];
  bytes.push(0xff, 0xfe, ...u16(comment.length + 2), ...comment);
  bytes.push(
    0xff,
    0xc0,
    ...u16(17),
    8,
    ...u16(120),
    ...u16(160),
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  );
  bytes.push(0xff, 0xd9);
  return new Uint8Array(bytes);
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

test("reads JPEG dimensions and COM comments", async () => {
  const stream = await RipstreamInputStream.from(sampleJpeg());
  const metadata = new Metadata();
  await new ImageParser().parse(
    stream,
    new BodyContentHandler(),
    metadata,
    new ParseContext(),
  );
  await stream.close();
  assert.equal(metadata.get("tiff:ImageWidth"), "160");
  assert.equal(metadata.get("tiff:ImageLength"), "120");
  assert.deepEqual(metadata.getAll("comments"), ["A JPEG comment"]);
});
