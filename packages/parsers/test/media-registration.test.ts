import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MediaType, ParseContext } from "@spikedpunch/ripstream-core";
import { createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * Where the Ogg, AU, MIDI, MP4 and HEIF sequence types go (tikajs-68os.15), checked against the claims of Tika 4.2.0's
 * OggParser, VorbisParser, OpusParser, SpeexParser, FlacParser, TheoraParser, AudioParser, MidiParser, MP4Parser and
 * HeifParser, read from source; not run against a Tika. Detection of these types is pinned in packages/mime.
 */

/** The parser selectParsers picks first for a type, and how it matched. */
async function best(type: string): Promise<{ name: string; kind: string } | undefined> {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow(type), new ParseContext());
  const [first] = matches;
  return first === undefined ? undefined : { name: first.parser.name, kind: first.kind };
}

test("the Ogg types that resolved to no parser reach the general OggParser, and video/theora its own", async () => {
  for (const type of [
    "application/ogg",
    "video/ogg",
    "application/kate",
    "video/daala",
    "video/x-dirac",
    "video/x-oggrgb",
    "video/x-ogguvs",
    "video/x-oggyuv",
    "video/x-ogm",
  ]) {
    assert.deepEqual(await best(type), { name: "OggParser", kind: "exact" }, type);
  }
  assert.deepEqual(await best("video/theora"), { name: "TheoraParser", kind: "exact" });
});

test("the audio Ogg types that fell back to AudioParser reach the parser of their codec", async () => {
  assert.deepEqual(await best("audio/vorbis"), { name: "VorbisParser", kind: "exact" });
  assert.deepEqual(await best("audio/opus"), { name: "OpusParser", kind: "exact" });
  assert.deepEqual(await best("audio/speex"), { name: "SpeexParser", kind: "exact" });
  assert.deepEqual(await best("audio/x-oggflac"), { name: "FlacParser", kind: "exact" });
  assert.deepEqual(await best("audio/x-oggpcm"), { name: "OggParser", kind: "exact" });
});

test("native FLAC and its alias reach the FlacParser, which reads them as Tika does (tikajs-68os.61)", async () => {
  assert.deepEqual(await best("audio/x-flac"), { name: "FlacParser", kind: "exact" });
  assert.deepEqual(await best("audio/flac"), { name: "FlacParser", kind: "exact" });
});

// Tika's FlacParserTest.testCoverArt and testMultipleCovers, through the default parser and a recursive parse.
test("the pictures of a native FLAC file are embedded documents with the metadata Tika gives them", async () => {
  const ripstream = createRipstream();
  const one = await ripstream.parseRecursive(media("testFLAC_coverArt.flac"));
  assert.equal(one.length, 2);
  assert.equal(one[0]!.metadata.get("Content-Type"), "audio/x-flac");
  assert.deepEqual(
    [one[1]!.metadata.get("Content-Type"), one[1]!.metadata.get("tk:embedded-resource-type"), one[1]!.metadata.get("dc:title"), one[1]!.metadata.get("dc:description")],
    ["image/png", "THUMBNAIL", "Test Cover", "Cover (front)"],
  );
  const two = await ripstream.parseRecursive(media("testFLAC_twoCovers.flac"));
  assert.deepEqual(two.map((entry) => entry.metadata.get("tk:embedded-resource-type")), [null, "THUMBNAIL", "INLINE"]);
});

test("a bare audio/ogg goes to the general OggParser, and not to AudioParser", async () => {
  assert.deepEqual(await best("audio/ogg"), { name: "OggParser", kind: "exact" });
});

test("the claims only: audio/basic, application/x-midi, application/mp4 and the HEIF sequences", async () => {
  assert.deepEqual(await best("audio/basic"), { name: "AudioParser", kind: "exact" });
  assert.deepEqual(await best("application/x-midi"), { name: "MidiParser", kind: "exact" });
  assert.deepEqual(await best("application/mp4"), { name: "MP4Parser", kind: "exact" });
  assert.deepEqual(await best("image/heic-sequence"), { name: "ImageParser", kind: "exact" });
  assert.deepEqual(await best("image/heif-sequence"), { name: "ImageParser", kind: "exact" });
});

const media = (name: string): Uint8Array => readFileSync(join(import.meta.dirname, "fixtures", "media", name));

// Tika's VorbisParserTest.testCoverArt and testMultipleCovers, through the default parser and a recursive parse.
test("the pictures of a Vorbis file are embedded documents with the metadata Tika gives them", async () => {
  const ripstream = createRipstream();
  const one = await ripstream.parseRecursive(media("testVORBIS_coverArt.ogg"));
  assert.equal(one.length, 2);
  assert.equal(one[0]!.metadata.get("Content-Type"), "audio/vorbis");
  assert.equal(one[0]!.metadata.get("vorbis:metadata_block_picture"), null);
  const picture = one[1]!.metadata;
  assert.equal(picture.get("Content-Type"), "image/png");
  assert.equal(picture.get("tk:embedded-resource-type"), "THUMBNAIL");
  assert.equal(picture.get("dc:title"), "Test Cover");
  assert.equal(picture.get("dc:description"), "Cover (front)");

  const two = await ripstream.parseRecursive(media("testVORBIS_twoCovers.ogg"));
  assert.equal(two.length, 3);
  assert.equal(two[0]!.metadata.get("vorbis:metadata_block_picture"), null);
  const [, front, back] = two.map((entry) => entry.metadata);
  assert.deepEqual(
    [front!, back!].map((m) => [m.get("Content-Type"), m.get("dc:title"), m.get("dc:description"), m.get("tk:embedded-resource-type")]),
    [
      ["image/png", "Front Cover", "Cover (front)", "THUMBNAIL"],
      ["image/png", "Back Cover", "Cover (back)", "INLINE"],
    ],
  );
});
