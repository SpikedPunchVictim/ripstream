import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { AudioParser } from "../src/index.ts";

function wav(): Uint8Array {
  const samples = 8000;
  const data = new Uint8Array(44 + samples * 2);
  const view = new DataView(data.buffer);
  const ascii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index++) data[offset + index] = value.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return data;
}

test("reads audio duration and format metadata", async () => {
  const stream = await RipstreamInputStream.from(wav());
  const metadata = new Metadata();
  metadata.set("Content-Type", "audio/wav");
  await new AudioParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.ok(Number(metadata.get("xmpDM:duration")) > 0.9);
  assert.ok(Number(metadata.get("audio:bitrate")) > 0);
});
