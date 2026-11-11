import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream, createOutputHandler } from "@spikedpunch/ripstream-core";
import { AudioParser } from "../src/audio.ts";
import { concat, u32be } from "./ogg-builder.ts";

/*
 * Tika's AudioParser on a .au file (audio/basic): the format that the JDK's javax.sound reader reports, written as
 * metadata. The expected values of testAU.au are those of Tika 4.2.0's AudioParserTest.testAU. How the JDK reader treats
 * the other encodings is from memory of the JDK, not read from the Tika tree.
 */

function auHeader(encoding: number, rate = 44100, channels = 2, headerSize = 24): Uint8Array {
  return concat(Uint8Array.of(0x2e, 0x73, 0x6e, 0x64), u32be(headerSize), u32be(0xffffffff), u32be(encoding), u32be(rate), u32be(channels));
}

async function parseAu(bytes: Uint8Array): Promise<Metadata> {
  const metadata = new Metadata();
  metadata.set("Content-Type", "audio/basic");
  const stream = await RipstreamInputStream.from(bytes);
  try {
    await new AudioParser().parse(stream, createOutputHandler("body"), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

test("the AudioParser claims audio/basic, and no longer audio/ogg", () => {
  const claims = [...new AudioParser().getSupportedTypes()].map(String);
  assert.ok(claims.includes("audio/basic"));
  assert.ok(!claims.includes("audio/ogg"), "Ogg is read by the Ogg parsers");
});

test("a 16 bit PCM header gives the format of testAU.au", async () => {
  const metadata = await parseAu(auHeader(3));
  assert.equal(metadata.get("Content-Type"), "audio/basic");
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "44100");
  assert.equal(metadata.get("audio:channels"), "2");
  assert.equal(metadata.get("audio:bits-per-sample"), "16");
  assert.equal(metadata.get("audio:encoding"), "PCM_SIGNED");
  assert.equal(metadata.get("xmpDM:audioSampleType"), "16Int");
  assert.equal(metadata.has("tk:exception:warn"), false);
});

test("each encoding the reader takes: its name and its sample size", async () => {
  const seen = new Map<number, string>();
  for (const encoding of [1, 2, 3, 4, 5, 27]) {
    const metadata = await parseAu(auHeader(encoding, 8000, 1));
    seen.set(encoding, `${metadata.get("audio:encoding")} ${metadata.get("audio:bits-per-sample")} ${metadata.get("xmpDM:audioSampleType")}`);
  }
  assert.deepEqual([...seen], [
    [1, "ULAW 8 8Int"],
    [2, "PCM_SIGNED 8 8Int"],
    [3, "PCM_SIGNED 16 16Int"],
    [4, "PCM_SIGNED 24 null"],
    [5, "PCM_SIGNED 32 32Int"],
    [27, "ALAW 8 8Int"],
  ]);
});

test("an encoding the reader does not take, a wrong magic and a header too short only leave a warning", async () => {
  const wrongMagic = auHeader(3);
  wrongMagic[0] = 0;
  for (const bytes of [auHeader(6), auHeader(0), auHeader(3, 44100, 2, 20), wrongMagic, new Uint8Array(0)]) {
    const metadata = await parseAu(bytes);
    assert.equal(metadata.getAll("tk:exception:warn").length, 1);
    assert.match(metadata.get("tk:exception:warn")!, /^An UnsupportedAudioFileException was thrown\./);
    assert.equal(metadata.has("audio:channels"), false);
    assert.equal(metadata.has("audio:encoding"), false);
  }
});

test("every prefix of a header is read or left with the warning, and never fails", async () => {
  const whole = auHeader(3);
  for (let length = 0; length <= whole.length; length++) {
    const metadata = await parseAu(whole.subarray(0, length));
    assert.equal(metadata.has("audio:encoding"), length === whole.length, `prefix of ${length} bytes`);
  }
});

test("a header with a hostile data size reads no more than the header", async () => {
  // The data size is 0xffffffff; nothing is allocated for it, and 5 MB of body is never read.
  const metadata = await parseAu(concat(auHeader(3), new Uint8Array(5 * 1024 * 1024)));
  assert.equal(metadata.get("audio:encoding"), "PCM_SIGNED");
});
