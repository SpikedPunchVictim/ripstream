import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
  type InputSource,
} from "@spikedpunch/ripstream-core";
import { AudioParser, FlacParser } from "../src/index.ts";
import { DEFAULT_MAX_FLAC_METADATA_BYTES } from "../src/flac.ts";
import { concat, enc, flacTagsPacket, oggFlacFirst, u32be, u32le } from "./ogg-builder.ts";

/*
 * The native FLAC half of Tika 4.2.0's FlacParser (tikajs-68os.61): the stream info, the Vorbis comments and the PICTURE
 * blocks of a .flac file. The expectations of the real files are those of AutoDetectParserTest.testOggFlacAudio and
 * FlacParserTest; what vorbis-java does with a file that is not well formed is not in the Tika tree, and is marked as
 * from memory where a test depends on it. Read from the Tika source; not run against a Tika.
 */

interface Parsed {
  readonly metadata: Metadata;
  readonly text: string;
  readonly embedded: Metadata[];
}

async function parseFlac(source: InputSource, parser = new FlacParser()): Promise<Parsed> {
  const ctx = new ParseContext();
  const embedded = new EmbeddedDocumentBytesHandler();
  ctx.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, embedded);
  const metadata = new Metadata();
  const handler = createOutputHandler("body");
  const stream = await RipstreamInputStream.from(source);
  try {
    await parser.parse(stream, handler, metadata, ctx);
  } finally {
    await stream.close();
  }
  return { metadata, text: handler.toString(), embedded: embedded.resources.map((r) => r.metadata) };
}

const MEDIA = new URL("../../parsers/test/fixtures/media/", import.meta.url);
const real = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, MEDIA)));

const picture = (metadata: Metadata): string[] => [
  metadata.get("Content-Type")!,
  metadata.get("tk:embedded-resource-type")!,
  metadata.get("dc:title")!,
  metadata.get("dc:description")!,
];

// ---- the real files of Tika ------------------------------------------------------------------------------------------

test("testFLAC.flac of Tika: the type, the tags, the layout and the rate of AutoDetectParserTest.testOggFlacAudio", async () => {
  const { metadata, text, embedded } = await parseFlac(real("testFLAC.flac"));
  assert.equal(metadata.get("Content-Type"), "audio/x-flac");
  assert.equal(metadata.get("xmpDM:audioCompressor"), "FLAC");
  assert.equal(metadata.get("dc:creator"), "Test Artist");
  assert.equal(metadata.get("dc:title"), "Test Title");
  assert.equal(metadata.get("xmpDM:artist"), "Test Artist");
  assert.equal(metadata.get("xmpDM:album"), "Test Album");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Stereo");
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "44100");
  assert.ok(text.includes("Test Title") && text.includes("Test Artist"));
  assert.equal(embedded.length, 0);
});

test("testFLAC.flac of Tika: the duration is the samples of the stream info over its rate (960 samples at 44100 Hz)", async () => {
  const { metadata, text } = await parseFlac(real("testFLAC.flac"));
  assert.equal(metadata.get("xmpDM:duration"), "0.02");
  assert.ok(text.endsWith("0:00\n"), JSON.stringify(text));
});

test("testFLAC_coverArt.flac of Tika: one picture, the thumbnail (FlacParserTest.testCoverArt)", async () => {
  const { metadata, embedded } = await parseFlac(real("testFLAC_coverArt.flac"));
  assert.equal(metadata.get("Content-Type"), "audio/x-flac");
  assert.equal(embedded.length, 1);
  assert.deepEqual(picture(embedded[0]!), ["image/png", "THUMBNAIL", "Test Cover", "Cover (front)"]);
});

test("testFLAC_twoCovers.flac of Tika: a picture for each block in file order, the front cover the thumbnail (FlacParserTest.testMultipleCovers)", async () => {
  const { embedded } = await parseFlac(real("testFLAC_twoCovers.flac"));
  assert.equal(embedded.length, 2);
  assert.deepEqual(picture(embedded[0]!), ["image/png", "THUMBNAIL", "Front Cover", "Cover (front)"]);
  assert.deepEqual(picture(embedded[1]!), ["image/png", "INLINE", "Back Cover", "Cover (back)"]);
});

test("testFLAC_commentAndNativePicture.flac of Tika: the comment picture first, one thumbnail in all (FlacParserTest)", async () => {
  const { metadata, embedded } = await parseFlac(real("testFLAC_commentAndNativePicture.flac"));
  assert.equal(embedded.length, 2);
  assert.equal(embedded[0]!.get("dc:title"), "Comment cover");
  assert.deepEqual(embedded.map((one) => one.get("tk:embedded-resource-type")), ["THUMBNAIL", "INLINE"]);
  assert.equal(metadata.has("vorbis:metadata_block_picture"), false);
});

test("the FlacParser still reads FLAC in Ogg (testFLAC.oga of Tika) and keeps its type", async () => {
  const { metadata } = await parseFlac(real("testFLAC.oga"));
  assert.equal(metadata.get("Content-Type"), "audio/x-oggflac");
  assert.equal(metadata.get("dc:title"), "Test Title");
});

// ---- files built here ------------------------------------------------------------------------------------------------

const MAGIC = enc("fLaC");

/** A metadata block: the flag and type byte, a 24 bit big-endian length, the body. */
function block(type: number, body: Uint8Array, last = false): Uint8Array {
  return concat(Uint8Array.of((last ? 0x80 : 0) | type, body.length >>> 16, (body.length >>> 8) & 0xff, body.length & 0xff), body);
}

/** The STREAMINFO block (not the last one) that oggFlacFirst holds after its 13 bytes of Ogg mapping header. */
const streamInfo = (spec: Parameters<typeof oggFlacFirst>[0] = {}): Uint8Array => oggFlacFirst(spec).subarray(13);

function pictureBody(description: string, type = 3, data = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)): Uint8Array {
  const mime = enc("image/png");
  const text = enc(description);
  return concat(u32be(type), u32be(mime.length), mime, u32be(text.length), text, new Uint8Array(16), u32be(data.length), data);
}

test("the stream info alone, with no comment block, gives the layout and the duration, and no tags", async () => {
  // From memory of vorbis-java, not read from the Tika tree: whether FlacFile accepts a file with no comment block. It
  // is read here, as an untagged FLAC file is common and music-metadata, which read these before, reads it.
  const file = concat(MAGIC, block(0, streamInfo({ rate: 48000, channels: 1, samples: 96000 }).subarray(4), true));
  const { metadata } = await parseFlac(file);
  assert.equal(metadata.get("Content-Type"), "audio/x-flac");
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "48000");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Mono");
  assert.equal(metadata.get("xmpDM:duration"), "2.0");
  assert.equal(metadata.has("dc:title"), false);
  assert.equal(metadata.has("vorbis:vendor"), false);
});

test("the blocks of other kinds are skipped, whatever their size", async () => {
  const file = concat(
    MAGIC,
    streamInfo(),
    block(1, new Uint8Array(100_000)),
    block(3, new Uint8Array(18)),
    flacTagsPacket("v", ["title=T"], false),
    block(5, new Uint8Array(50), true),
  );
  assert.equal((await parseFlac(file)).metadata.get("dc:title"), "T");
});

test("a block after the last-block flag is not read", async () => {
  const file = concat(MAGIC, streamInfo(), flacTagsPacket("v", ["title=T"], true), block(6, pictureBody("late")));
  const { embedded } = await parseFlac(file);
  assert.equal(embedded.length, 0);
});

test("a picture block that declares more data than the file has ends the walk and keeps the earlier pictures (FlacParserTest.testTruncatedPictureBlockKeepsEarlierPictures)", async () => {
  const file = concat(
    MAGIC,
    streamInfo(),
    flacTagsPacket("v", ["title=T"], false),
    block(6, pictureBody("front")),
    // Another picture block that claims 0xFFFF bytes and has 3.
    Uint8Array.of(0x80 | 6, 0, 0xff, 0xff, 1, 2, 3),
  );
  const { metadata, embedded } = await parseFlac(file);
  assert.equal(metadata.get("dc:title"), "T");
  assert.deepEqual(embedded.map((one) => one.get("dc:title")), ["front"]);
});

test("a skipped block that declares more data than the file has ends the walk, and the pictures before it are kept", async () => {
  const file = concat(MAGIC, streamInfo(), block(6, pictureBody("front")), Uint8Array.of(1, 0, 0xff, 0xff, 1, 2, 3));
  assert.deepEqual((await parseFlac(file)).embedded.map((one) => one.get("dc:title")), ["front"]);
});

test("a picture block that is not a picture is skipped, the others kept", async () => {
  const file = concat(MAGIC, streamInfo(), block(6, Uint8Array.of(1, 2, 3)), block(6, pictureBody("ok"), true));
  assert.deepEqual((await parseFlac(file)).embedded.map((one) => one.get("dc:title")), ["ok"]);
});

test("the tags come from the first comment block", async () => {
  const file = concat(MAGIC, streamInfo(), flacTagsPacket("v", ["title=First"], false), flacTagsPacket("v", ["title=Second"], true));
  assert.equal((await parseFlac(file)).metadata.get("dc:title"), "First");
});

test("a file that is not FLAC, or has no stream info first, or ends inside the stream info or the comments is a MalformedDocumentError", async () => {
  const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["not flac", enc("RIFF....WAVEfmt ")],
    ["magic only", MAGIC],
    ["a comment block first", concat(MAGIC, flacTagsPacket("v", ["title=T"]))],
    ["stream info too short", concat(MAGIC, block(0, new Uint8Array(33), true))],
    ["stream info cut", concat(MAGIC, streamInfo().subarray(0, 20))],
    ["comments cut", concat(MAGIC, streamInfo(), flacTagsPacket("v", ["title=Test"], true).subarray(0, 12))],
    ["a comment count the block cannot hold", concat(MAGIC, streamInfo(), block(4, concat(u32le(0), u32le(1000)), true))],
  ];
  const wrong: string[] = [];
  for (const [label, bytes] of cases) {
    try {
      await parseFlac(bytes);
      wrong.push(`${label}: parsed`);
    } catch (error) {
      if (!(error instanceof MalformedDocumentError)) wrong.push(`${label}: ${String(error)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// ---- bounds ----------------------------------------------------------------------------------------------------------

/** `head`, then 1 KiB chunks of audio without end, counting the bytes that were pulled. */
function countingFlac(head: Uint8Array): { source: AsyncIterable<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    pulled += head.length;
    yield head;
    for (let index = 0; index < 1024 * 1024; index++) {
      pulled += 1024;
      yield new Uint8Array(1024).fill(0xff);
    }
  }
  return { source: source(), pulled: () => pulled };
}

test("the audio frames are never read: a stream with a gigabyte of them is pulled for its metadata and one chunk more", async () => {
  const head = concat(MAGIC, streamInfo(), flacTagsPacket("v", ["title=T"], true));
  const { source, pulled } = countingFlac(head);
  const { metadata } = await parseFlac(source);
  assert.equal(metadata.get("dc:title"), "T");
  // The head is the first chunk and the last block ends in it, so nothing after it is wanted.
  assert.equal(pulled(), head.length);
});

test("metadata over maxMetadataBytes is a LimitExceededError, read no further than the block that crosses it", async () => {
  // Blocks of padding without end and no last-block flag: 4 + 1000 bytes each, after the 42 bytes of magic and stream info.
  const padding = block(1, new Uint8Array(1000));
  let pulled = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    const head = concat(MAGIC, streamInfo());
    pulled += head.length;
    yield head;
    for (let index = 0; index < 1_000_000; index++) {
      pulled += padding.length;
      yield padding;
    }
  }
  const parser = new FlacParser({ maxMetadataBytes: 4000 });
  await assert.rejects(parseFlac(source(), parser), LimitExceededError);
  // The magic and stream info are 42 bytes; the budget (4000) covers 3 blocks of 1004 and the fourth crosses it, and
  // it is refused before it is read: the stream is pulled for the blocks that were skipped, not for more.
  assert.equal(pulled, 42 + 4 * padding.length);
});

test("the default metadata limit is 64 MiB, and a limit that is not a positive integer is a RangeError", () => {
  assert.equal(DEFAULT_MAX_FLAC_METADATA_BYTES, 64 * 1024 * 1024);
  for (const maxMetadataBytes of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new FlacParser({ maxMetadataBytes }), RangeError, String(maxMetadataBytes));
  }
});

// ---- claims ----------------------------------------------------------------------------------------------------------

test("the FlacParser claims native FLAC, its alias and Ogg FLAC, and the AudioParser no longer claims FLAC", () => {
  const claims = (parser: { getSupportedTypes(): ReadonlySet<unknown> }): string[] => [...parser.getSupportedTypes()].map(String).sort();
  assert.deepEqual(claims(new FlacParser()), ["audio/flac", "audio/x-flac", "audio/x-oggflac"]);
  const audio = claims(new AudioParser());
  assert.ok(!audio.includes("audio/flac") && !audio.includes("audio/x-flac"), audio.join(", "));
});
