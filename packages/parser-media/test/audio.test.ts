import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  type ContentHandler,
  Metadata,
  LimitExceededError,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { AudioParser } from "../src/index.ts";
import { DEFAULT_MAX_AUDIO_BYTES } from "../src/audio.ts";

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

test("the music-metadata branch writes the empty document, so the metadata is in the head of the xml (AudioParser.java:146-148)", async () => {
  const stream = await RipstreamInputStream.from(wav());
  const metadata = new Metadata();
  metadata.set("Content-Type", "audio/wav");
  const handler = createOutputHandler("xml");
  await new AudioParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  const xml = handler.toString();
  assert.match(xml, /^<html>\n<head>/);
  assert.match(xml, /<meta name="xmpDM:duration" content="[0-9.]+"><\/meta>/);
});

/** 0xFF bytes in chunks of `chunkBytes`, `chunkCount` of them, counting how many bytes the consumer pulled. */
function countingFfStream(chunkBytes: number, chunkCount: number): { source: AsyncIterable<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < chunkCount; index++) {
      pulled += chunkBytes;
      yield new Uint8Array(chunkBytes).fill(0xff);
    }
  }
  return { source: source(), pulled: () => pulled };
}

test("an input over maxBytes is a LimitExceededError after one chunk past the limit, and is never handed to music-metadata", async () => {
  // 0xFF everywhere is the worst case of music-metadata's MPEG sync scan (about 3 s of CPU per MiB), so the size is
  // refused before that. The input has 1 GiB of 1 KiB chunks; with a 4096 byte limit the fifth chunk is the first to
  // take the buffer past it, and nothing more is read.
  const { source, pulled } = countingFfStream(1024, 1024 * 1024);
  const stream = await RipstreamInputStream.from(source);
  const metadata = new Metadata();
  metadata.set("Content-Type", "audio/mpeg");
  try {
    await assert.rejects(
      new AudioParser({ maxBytes: 4096 }).parse(stream, new BodyContentHandler(), metadata, new ParseContext()),
      LimitExceededError,
    );
  } finally {
    await stream.close();
  }
  assert.equal(pulled(), 5 * 1024);
});

test("an input of exactly maxBytes is parsed", async () => {
  const bytes = wav();
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  metadata.set("Content-Type", "audio/wav");
  await new AudioParser({ maxBytes: bytes.length }).parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.ok(Number(metadata.get("xmpDM:duration")) > 0.9);
});

test("the default limit is 64 MiB, and a limit that is not a positive integer is a RangeError", () => {
  assert.equal(DEFAULT_MAX_AUDIO_BYTES, 64 * 1024 * 1024);
  for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new AudioParser({ maxBytes }), RangeError, String(maxBytes));
  }
});

/** Records the calls of the document: only these two, which the XHTMLContentHandler passes on. */
function recorder(): { handler: ContentHandler; events: string[] } {
  const events: string[] = [];
  return {
    events,
    handler: {
      startDocument: () => void events.push("startDocument"),
      endDocument: () => void events.push("endDocument"),
    },
  };
}

async function parseWith(bytes: Uint8Array, contentType: string | null, handler: ContentHandler = new BodyContentHandler()): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  if (contentType !== null) metadata.set("Content-Type", contentType);
  try {
    await new AudioParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

test("the music-metadata branch starts and ends the document, once each", async () => {
  const { handler, events } = recorder();
  await parseWith(wav(), "audio/wav", handler);
  assert.deepEqual(events, ["startDocument", "endDocument"]);
});

test("an input one byte over maxBytes is a LimitExceededError", async () => {
  const bytes = wav();
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  metadata.set("Content-Type", "audio/wav");
  try {
    await assert.rejects(
      new AudioParser({ maxBytes: bytes.length - 1 }).parse(stream, new BodyContentHandler(), metadata, new ParseContext()),
      LimitExceededError,
    );
  } finally {
    await stream.close();
  }
});

test("an input without a Content-Type is read by music-metadata, not taken for AU", async () => {
  const metadata = await parseWith(wav(), null);
  assert.ok(Number(metadata.get("xmpDM:duration")) > 0.9);
});

test("the duration of an MP3 whose frames differ in bitrate is summed over its frames (music-metadata's duration option)", async () => {
  // 48 MPEG 1 Layer 3 frames at 44100 Hz, two thirds of 64 kbit/s (208 bytes) and one third of 128 kbit/s (417 bytes):
  // 48 * 1152 samples, 1.2539 s. Without the option music-metadata reports no duration of such a file.
  const bytes = new Uint8Array(40 * 417);
  let position = 0;
  for (let index = 0; index < 60; index++) {
    const wide = index % 3 !== 0;
    const size = wide ? 417 : 208;
    if (position + size > bytes.length) break;
    bytes.set([0xff, 0xfb, wide ? 0x90 : 0x50, 0x00], position);
    position += size;
  }
  const metadata = await parseWith(bytes.subarray(0, position), "audio/mpeg");
  assert.ok(Math.abs(Number(metadata.get("xmpDM:duration")) - 1.2539) < 0.001, String(metadata.get("xmpDM:duration")));
});

test("the AudioParser claims MP3, WAV, AIFF, M4A, WMA and AU, by the names Tika's registry gives them", () => {
  assert.deepEqual([...new AudioParser().getSupportedTypes()].map(String).sort(), [
    "audio/aiff",
    "audio/basic",
    "audio/mp4",
    "audio/mpeg",
    "audio/vnd.wave",
    "audio/wav",
    "audio/x-aiff",
    "audio/x-m4a",
    "audio/x-ms-wma",
    "audio/x-wav",
  ]);
});
