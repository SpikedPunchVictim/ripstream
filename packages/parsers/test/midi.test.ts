import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { MidiParser } from "../src/index.ts";

test("reads MIDI header metadata", async () => {
  const data = new Uint8Array(14);
  data.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0, 96]);
  const stream = await RipstreamInputStream.from(data);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new MidiParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("audio:track-count"), "2");
  assert.match(handler.toString(), /Tracks: 2/);
});
