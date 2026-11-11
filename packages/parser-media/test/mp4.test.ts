import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { Mp4Parser } from "../src/index.ts";

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...payload];
}

function sample(): Uint8Array {
  const ftyp = box("ftyp", [...[... "isom"].map((c) => c.charCodeAt(0)), ...u32(0)]);
  const mvhdPayload = new Array(100).fill(0);
  const mvhd = box("mvhd", [...mvhdPayload, ...u32(1000), ...u32(5000)]);
  // timescale/duration live at fixed offsets; rebuild with the header layout.
  const mvhdBytes = new Uint8Array(8 + 100);
  const view = new DataView(mvhdBytes.buffer);
  view.setUint32(0, 108);
  mvhdBytes.set([0x6d, 0x76, 0x68, 0x64], 4);
  view.setUint32(20, 1000);
  view.setUint32(24, 5000);
  const moov = box("moov", [...mvhdBytes]);
  void mvhd;
  return new Uint8Array([...ftyp, ...moov]);
}

async function parseMp4(bytes: Uint8Array): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  await new Mp4Parser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  return metadata;
}

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

/** Seconds from the QuickTime epoch (1904-01-01) to the Unix epoch. */
const QT_EPOCH_OFFSET = 2_082_844_800;

function mvhd(version: 0 | 1, created: number, modified: number, timescale: number, duration: number): number[] {
  const header = version === 0 ? [...u32(created), ...u32(modified), ...u32(timescale), ...u32(duration)] : [
    ...u32(0), ...u32(created), ...u32(0), ...u32(modified), ...u32(timescale), ...u32(0), ...u32(duration),
  ];
  return box("mvhd", [version, 0, 0, 0, ...header, ...new Array(80).fill(0)]);
}

function movie(...children: number[][]): Uint8Array {
  const ftyp = box("ftyp", [...[..."qt  "].map((c) => c.charCodeAt(0)), ...u32(0)]);
  return new Uint8Array([...ftyp, ...box("moov", children.flat())]);
}

function track(handler: string, sampleEntry: number[]): number[] {
  const hdlr = box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0, ...[...handler].map((c) => c.charCodeAt(0)), ...new Array(13).fill(0)]);
  const stsd = box("stsd", [0, 0, 0, 0, ...u32(1), ...sampleEntry]);
  return box("trak", box("mdia", [...hdlr, ...box("minf", box("stbl", stsd))]));
}

function videoEntry(width: number, height: number): number[] {
  // SampleEntry (6 reserved, data reference index), then the VisualSampleEntry fields up to width and height.
  return box("avc1", [...new Array(6).fill(0), ...u16(1), ...new Array(16).fill(0), ...u16(width), ...u16(height), ...new Array(50).fill(0)]);
}

// Tika's MP4Parser (processActualMp4Directory, handleDurationInSeconds): read from Tika source, not run against a Tika.
test("reads MP4 duration as xmpDM:duration in Tika's 0.0# format, and writes no audio:spi-duration", async () => {
  const metadata = await parseMp4(sample());
  assert.equal(metadata.get("xmpDM:duration"), "5.0");
  assert.equal(metadata.get("audio:spi-duration"), null);
});

test("rounds the duration to two places, half to even, as Tika's DecimalFormat does", async () => {
  const cases: Array<[number, number, string]> = [
    [1000, 1234, "1.23"],
    [1000, 1235, "1.24"], // 1.235 as a double is 1.2350000000000000977, above the tie
    [1000, 125, "0.12"], // exact tie, rounds to the even 0.12
    [1000, 375, "0.38"], // exact tie, rounds to the even 0.38
    [1000, 625, "0.62"],
    [1000, 5, "0.01"],
    [1000, 0, "0.0"],
    [600, 6000, "10.0"],
  ];
  for (const [timescale, duration, expected] of cases) {
    const metadata = await parseMp4(movie(mvhd(0, 0, 0, timescale, duration)));
    assert.equal(metadata.get("xmpDM:duration"), expected, `${duration}/${timescale}`);
  }
});

test("a zero time scale writes no duration", async () => {
  const metadata = await parseMp4(movie(mvhd(0, 0, 0, 0, 5000)));
  assert.equal(metadata.get("xmpDM:duration"), null);
});

test("reads the creation and modification time as dcterms:created and dcterms:modified, to the second", async () => {
  // 2012-01-28T18:39:18Z and 2012-01-28T18:40:25Z: the values Tika's MP4ParserTest asserts for its audio file.
  const created = Date.UTC(2012, 0, 28, 18, 39, 18) / 1000 + QT_EPOCH_OFFSET;
  const modified = Date.UTC(2012, 0, 28, 18, 40, 25) / 1000 + QT_EPOCH_OFFSET;
  for (const version of [0, 1] as const) {
    const metadata = await parseMp4(movie(mvhd(version, created, modified, 1000, 2500)));
    assert.equal(metadata.get("dcterms:created"), "2012-01-28T18:39:18Z", `v${version}`);
    assert.equal(metadata.get("dcterms:modified"), "2012-01-28T18:40:25Z", `v${version}`);
    assert.equal(metadata.get("xmpDM:duration"), "2.5", `v${version}`);
  }
});

test("reads the width and height of a video track as tiff:ImageWidth and tiff:ImageLength", async () => {
  const metadata = await parseMp4(movie(mvhd(0, 0, 0, 1000, 1000), track("vide", videoEntry(1920, 1080))));
  assert.equal(metadata.get("tiff:ImageWidth"), "1920");
  assert.equal(metadata.get("tiff:ImageLength"), "1080");
});

test("an audio track gives no image size, and the last video track wins", async () => {
  const audioOnly = await parseMp4(movie(mvhd(0, 0, 0, 1000, 1000), track("soun", videoEntry(640, 480))));
  assert.equal(audioOnly.get("tiff:ImageWidth"), null);
  const two = await parseMp4(
    movie(mvhd(0, 0, 0, 1000, 1000), track("vide", videoEntry(640, 480)), track("vide", videoEntry(1280, 720))),
  );
  assert.equal(two.get("tiff:ImageWidth"), "1280");
  assert.equal(two.get("tiff:ImageLength"), "720");
});

test("rejects files without moov", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array(16));
  await assert.rejects(
    new Mp4Parser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
