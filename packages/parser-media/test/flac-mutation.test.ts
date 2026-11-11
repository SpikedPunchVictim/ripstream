import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
  type InputSource,
} from "@spikedpunch/ripstream-core";
import { FlacParser } from "../src/index.ts";
import { readNativeFlac } from "../src/flac.ts";
import { concat, enc, flacTagsPacket, oggFlacFirst } from "./ogg-builder.ts";

/*
 * Behaviour of the native FLAC walk that flac.test.ts leaves open, found by mutating src/flac.ts and the FlacParser of
 * src/ogg.ts: the exact edges of the metadata budget, the first block, the last-block flag, the 24 bit lengths and the
 * ends of a file inside the walk. Read from the Tika source (FlacParser.readNativePictures); not run against a Tika.
 */

async function parseFlac(source: InputSource, parser = new FlacParser()): Promise<Metadata> {
  const metadata = new Metadata();
  const stream = await RipstreamInputStream.from(source);
  try {
    await parser.parse(stream, createOutputHandler("body"), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

const MAGIC = enc("fLaC");

/** A metadata block: the flag and type byte, a 24 bit big-endian length, the body. */
function block(type: number, body: Uint8Array, last = false): Uint8Array {
  return concat(Uint8Array.of((last ? 0x80 : 0) | type, body.length >>> 16, (body.length >>> 8) & 0xff, body.length & 0xff), body);
}

/** The STREAMINFO block (not the last one) that oggFlacFirst holds after its 13 bytes of Ogg mapping header: 4 + 34 bytes. */
const streamInfo = (spec: Parameters<typeof oggFlacFirst>[0] = { rate: 48000, channels: 1, samples: 96000 }): Uint8Array =>
  oggFlacFirst(spec).subarray(13);
const STREAM_INFO_BODY = streamInfo().subarray(4);
const lastStreamInfo = (): Uint8Array => block(0, STREAM_INFO_BODY, true);

// ---- the metadata budget ---------------------------------------------------------------------------------------------

test("the budget counts the 4 byte header of the stream info: 38 bytes pass a limit of 38 and fail a limit of 37", async () => {
  const file = concat(MAGIC, lastStreamInfo());
  assert.equal((await parseFlac(file, new FlacParser({ maxMetadataBytes: 38 }))).get("xmpDM:audioSampleRate"), "48000");
  await assert.rejects(parseFlac(file, new FlacParser({ maxMetadataBytes: 37 })), LimitExceededError);
});

test("a limit smaller than the stream info is a LimitExceededError even when no other block follows", async () => {
  await assert.rejects(parseFlac(concat(MAGIC, lastStreamInfo()), new FlacParser({ maxMetadataBytes: 1 })), LimitExceededError);
});

test("the budget counts the 4 byte header of every later block: the blocks of 52 bytes pass a limit of 52 and fail a limit of 51", async () => {
  // 38 for the stream info, 4 + 10 for the padding block.
  const file = concat(MAGIC, streamInfo(), block(1, new Uint8Array(10), true));
  await parseFlac(file, new FlacParser({ maxMetadataBytes: 52 }));
  await assert.rejects(parseFlac(file, new FlacParser({ maxMetadataBytes: 51 })), LimitExceededError);
});

// ---- the first block -------------------------------------------------------------------------------------------------

test("readNativeFlac refuses what does not start with fLaC, an empty stream included, as a MalformedDocumentError", async () => {
  for (const bytes of [new Uint8Array(0), enc("fLa"), enc("RIFF....WAVEfmt ")]) {
    const stream = await RipstreamInputStream.from(bytes);
    try {
      await assert.rejects(readNativeFlac(stream, 1024), MalformedDocumentError, `${bytes.length} bytes`);
    } finally {
      await stream.close();
    }
  }
});

test("a first block of an unknown type (64) is not a stream info, whatever its length", async () => {
  const file = concat(MAGIC, block(0x40, STREAM_INFO_BODY, true));
  await assert.rejects(parseFlac(file), MalformedDocumentError);
});

test("a stream info longer than 34 bytes is read whole, so that the block after it is found", async () => {
  const file = concat(MAGIC, block(0, concat(STREAM_INFO_BODY, new Uint8Array(6))), flacTagsPacket("v", ["title=After"], true));
  assert.equal((await parseFlac(file)).get("dc:title"), "After");
});

// ---- the last-block flag ---------------------------------------------------------------------------------------------

test("a stream info with the last-block flag ends the walk: the comment block after it is not read", async () => {
  const file = concat(MAGIC, lastStreamInfo(), flacTagsPacket("v", ["title=Late"], true));
  const metadata = await parseFlac(file);
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "48000");
  assert.equal(metadata.has("dc:title"), false);
});

// ---- the end of the file inside the walk -----------------------------------------------------------------------------

test("a file that ends after the stream info, without the last-block flag, keeps the stream info", async () => {
  const metadata = await parseFlac(concat(MAGIC, streamInfo()));
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "48000");
});

test("a file that ends after a comment block, without the last-block flag, keeps the comments", async () => {
  const metadata = await parseFlac(concat(MAGIC, streamInfo(), flacTagsPacket("v", ["title=T"], false)));
  assert.equal(metadata.get("dc:title"), "T");
});

test("a skipped block that declares more than the file has ends the walk: the comment block after its header is not read", async () => {
  // The block of type 1 claims 0xFFFF bytes; the bytes that follow its header are a whole comment block, and are its data.
  const file = concat(MAGIC, streamInfo(), Uint8Array.of(1, 0, 0xff, 0xff), flacTagsPacket("v", ["title=Inside"], true));
  const metadata = await parseFlac(file);
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "48000");
  assert.equal(metadata.has("dc:title"), false);
});

// ---- the length of a block -------------------------------------------------------------------------------------------

test("the length of a block is 24 bits: a skipped block of 70000 bytes is skipped whole", async () => {
  // 0xFF bytes would be read as a header with the last-block flag, so a wrong length ends the walk before the comments.
  const file = concat(MAGIC, streamInfo(), block(1, new Uint8Array(70_000).fill(0xff)), flacTagsPacket("v", ["title=After"], true));
  assert.equal((await parseFlac(file)).get("dc:title"), "After");
});

test("the length of a block is 24 bits: a skipped block of 300 bytes is skipped whole", async () => {
  const file = concat(MAGIC, streamInfo(), block(1, new Uint8Array(300).fill(0xff)), flacTagsPacket("v", ["title=After"], true));
  assert.equal((await parseFlac(file)).get("dc:title"), "After");
});

// ---- the stream info -------------------------------------------------------------------------------------------------

test("the 36 bit sample count is read whole: 9 * 2^32 + 5000 samples at 1000 Hz", async () => {
  const file = concat(MAGIC, block(0, streamInfo({ rate: 1000, samples: 9 * 2 ** 32 + 5000 }).subarray(4), true));
  const metadata = await parseFlac(file);
  assert.ok(Math.abs(Number(metadata.get("xmpDM:duration")) - 38_654_710.664) < 0.01, String(metadata.get("xmpDM:duration")));
});

test("the 3 bit channel count gives the layouts of 5 and 7 channels, and none for 3", async () => {
  const layout = async (channels: number): Promise<string | null> => {
    const file = concat(MAGIC, block(0, streamInfo({ channels }).subarray(4), true));
    return (await parseFlac(file)).get("xmpDM:audioChannelType");
  };
  assert.equal(await layout(5), "5.1");
  assert.equal(await layout(7), "7.1");
  assert.equal(await layout(3), null);
});

test("a stream info with a sample rate of 0 and samples gives no duration, not an infinite one", async () => {
  const file = concat(MAGIC, block(0, streamInfo({ rate: 0, samples: 1000 }).subarray(4), true));
  const metadata = await parseFlac(file);
  assert.equal(metadata.has("xmpDM:duration"), false);
});

test("a file with no comment block has no creator tool either", async () => {
  const metadata = await parseFlac(concat(MAGIC, lastStreamInfo()));
  assert.equal(metadata.has("xmp:CreatorTool"), false);
});
