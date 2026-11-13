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

function u64(value: number): number[] {
  return [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)];
}

function mvhd(version: 0 | 1, created: number, modified: number, timescale: number, duration: number): number[] {
  const header = version === 0 ? [...u32(created), ...u32(modified), ...u32(timescale), ...u32(duration)] : [
    ...u64(created), ...u64(modified), ...u32(timescale), ...u64(duration),
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

function mdhd(timescale: number, duration: number): number[] {
  return box("mdhd", [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration), ...u16(0), ...u16(0)]);
}

function stts(entries: Array<[number, number]>): number[] {
  return box("stts", [0, 0, 0, 0, ...u32(entries.length), ...entries.flatMap(([count, delta]) => [...u32(count), ...u32(delta)])]);
}

function mediaTrack(handler: string, sampleEntry: number[], options: { mdhd?: number[]; stts?: number[] } = {}): number[] {
  const hdlr = box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0, ...[...handler].map((c) => c.charCodeAt(0)), ...new Array(13).fill(0)]);
  const stsd = box("stsd", [0, 0, 0, 0, ...u32(1), ...sampleEntry]);
  return box("trak", box("mdia", [...hdlr, ...(options.mdhd ?? []), ...box("minf", box("stbl", [...(options.stts ?? []), ...stsd]))]));
}

/** A VisualSampleEntry with a Pascal-string compressor name and optional child boxes. */
function visualEntry(type: string, width: number, height: number, compressor: string, children: number[] = []): number[] {
  const name = new Array(32).fill(0);
  name[0] = compressor.length;
  for (const [i, c] of [...compressor].entries()) name[i + 1] = c.charCodeAt(0);
  return box(type, [
    ...new Array(6).fill(0), ...u16(1), ...new Array(16).fill(0), ...u16(width), ...u16(height),
    ...new Array(14).fill(0), ...name, ...u16(24), ...u16(0), ...children,
  ]);
}

/** An AudioSampleEntry (version 0) with optional child boxes. */
function audioEntry(type: string, channels: number, sampleSize: number, children: number[] = []): number[] {
  const fields = [...u16(0), ...u16(0), ...u32(0), ...u16(channels), ...u16(sampleSize), ...u16(0), ...u16(0), ...u32(44100 << 16)];
  return box(type, [...new Array(6).fill(0), ...u16(1), ...fields, ...children]);
}

function btrt(averageBitrate: number): number[] {
  return box("btrt", [...u32(0), ...u32(0), ...u32(averageBitrate)]);
}

function esds(averageBitrate: number): number[] {
  const decoderConfig = [0x04, 13, 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(averageBitrate)];
  return box("esds", [0, 0, 0, 0, 0x03, 18, 0, 0, 0, ...decoderConfig]);
}

function sinf(original: string): number[] {
  return box("sinf", box("frma", [...[...original].map((c) => c.charCodeAt(0))]));
}

function metaBox(subtype: string, ...children: number[][]): number[] {
  const hdlr = box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0, ...[...subtype].map((c) => c.charCodeAt(0)), ...new Array(13).fill(0)]);
  return box("meta", [0, 0, 0, 0, ...hdlr, ...children.flat()]);
}

/** Apple writes QuickTime `meta` without the ISO FullBox version and flags. */
function quickTimeMetaBox(subtype: string, ...children: number[][]): number[] {
  const hdlr = box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0, ...[...subtype].map((c) => c.charCodeAt(0)), ...new Array(13).fill(0)]);
  return box("meta", [...hdlr, ...children.flat()]);
}

function udta(...children: number[][]): number[] {
  return box("udta", children.flat());
}

function keys(names: string[]): number[] {
  const payload = [0, 0, 0, 0, ...u32(names.length)];
  for (const name of names) {
    const bytes = [...name].map((c) => c.charCodeAt(0));
    payload.push(...u32(8 + bytes.length), ...u32(0), ...bytes);
  }
  return box("keys", payload);
}

function ilstEntry(index: number, valueType: number, value: number[]): number[] {
  const payload = [...u32(index), ...box("data", [...u32(valueType), ...u32(0), ...value])];
  return [...u32(payload.length + 4), ...payload];
}

function ilst(entries: number[][]): number[] {
  return box("ilst", entries.flat());
}

function ilstEntryBytes(fieldName: string, valueType: number, value: number[]): number[] {
  const payload = [...text(fieldName), ...box("data", [...u32(valueType), ...u32(0), ...value])];
  return [...u32(payload.length + 4), ...payload];
}

function text(value: string): number[] {
  return [...value].map((c) => c.charCodeAt(0));
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

test("writes a creation year outside 0000-9999 the way Java writes an Instant", async () => {
  const metadata = await parseMp4(movie(mvhd(1, 1_205_245_885_964, 3_563_053_673, 1000, 1000)));
  assert.equal(metadata.get("dcterms:created"), "+40096-09-19T03:52:44Z");
  assert.equal(metadata.get("dcterms:modified"), "2016-11-27T01:07:53Z");
});

test("reads the video track's codec, compressor, average bitrate and frame rate", async () => {
  const metadata = await parseMp4(
    movie(
      mvhd(0, 0, 0, 600, 6000),
      mediaTrack("vide", visualEntry("avc1", 1920, 1080, "H.264", btrt(1_500_000)), {
        mdhd: mdhd(1000, 10_000),
        stts: stts([[250, 40]]),
      }),
    ),
  );
  assert.equal(metadata.get("video:fourcc"), "avc1");
  assert.equal(metadata.get("xmpDM:videoCompressor"), "H.264");
  assert.equal(metadata.get("video:bitrate"), "1500000");
  // 1000 / (10000 / 250), in single precision, as metadata-extractor computes it.
  assert.equal(metadata.get("video:frame-rate"), "25.0");
  assert.equal(metadata.get("tiff:ImageWidth"), "1920");
  assert.equal(metadata.get("tiff:ImageLength"), "1080");
});

test("reads the sound track's codec, channel counts, sample size and average bitrate", async () => {
  const metadata = await parseMp4(
    movie(
      mvhd(0, 0, 0, 1000, 1000),
      mediaTrack("soun", audioEntry("mp4a", 2, 16, esds(128_000)), { mdhd: mdhd(44_100, 441_000) }),
    ),
  );
  assert.equal(metadata.get("audio:fourcc"), "mp4a");
  assert.equal(metadata.get("audio:channels"), "2");
  assert.equal(metadata.get("audio:bits-per-sample"), "16");
  assert.equal(metadata.get("xmpDM:audioChannelType"), "Stereo");
  assert.equal(metadata.get("audio:bitrate"), "128000");
  // The sound track's media time scale overrides the movie one.
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "44100");
});

test("writes the movie time scale as audio sample rate when there is no sound track", async () => {
  const metadata = await parseMp4(movie(mvhd(0, 0, 0, 600, 6000), track("vide", videoEntry(640, 480))));
  assert.equal(metadata.get("xmpDM:audioSampleRate"), "600");
});

test("a video track without stts writes no frame rate", async () => {
  const metadata = await parseMp4(movie(mvhd(0, 0, 0, 1000, 1000), mediaTrack("vide", visualEntry("avc1", 640, 480, ""), { mdhd: mdhd(1000, 5000) })));
  assert.equal(metadata.get("video:frame-rate"), null);
});

test("a protected sample entry reports the original codec from its sinf/frma", async () => {
  const video = await parseMp4(movie(mvhd(0, 0, 0, 1000, 1000), mediaTrack("vide", visualEntry("encv", 640, 480, "", sinf("avc1")))));
  assert.equal(video.get("video:fourcc"), "avc1");
  const audio = await parseMp4(movie(mvhd(0, 0, 0, 1000, 1000), mediaTrack("soun", audioEntry("enca", 1, 16, sinf("mp4a")))));
  assert.equal(audio.get("audio:fourcc"), "mp4a");
  assert.equal(audio.get("audio:has-drm"), "true");
  assert.equal(audio.get("xmpDM:audioChannelType"), "Mono");
});

test("reads QuickTime mdta keys and maps an ISO 6709 location to geo fields", async () => {
  const metadata = await parseMp4(
    movie(
      mvhd(0, 0, 0, 1000, 1000),
      udta(metaBox("mdta", keys(["com.apple.quicktime.location.ISO6709", "com.apple.quicktime.make"]), ilst([
        ilstEntry(1, 1, text("+32.0929+034.8620+028.516/")),
        ilstEntry(2, 1, text("Apple")),
      ]))),
    ),
  );
  assert.equal(metadata.get("mp4:com.apple.quicktime.location.ISO6709"), "+32.0929+034.8620+028.516/");
  assert.equal(metadata.get("mp4:com.apple.quicktime.make"), "Apple");
  assert.equal(metadata.get("geo:lat"), "32.0929");
  assert.equal(metadata.get("geo:long"), "34.862");
  assert.equal(metadata.get("geo:alt"), "28.516");
});

test("reads a QuickTime meta box that has no ISO version and flags", async () => {
  const metadata = await parseMp4(
    movie(
      mvhd(0, 0, 0, 1000, 1000),
      quickTimeMetaBox("mdta", keys(["com.apple.quicktime.make"]), ilst([ilstEntry(1, 1, text("Apple"))])),
    ),
  );
  assert.equal(metadata.get("mp4:com.apple.quicktime.make"), "Apple");
});

test("reads legacy mdir items under Tika's keys", async () => {
  const metadata = await parseMp4(
    movie(
      mvhd(0, 0, 0, 1000, 1000),
      udta(metaBox("mdir", ilst([
        ilstEntryBytes("©nam", 1, text("A Title")),
        ilstEntryBytes("©ART", 1, text("An Artist")),
        ilstEntryBytes("©too", 1, text("iTunes 10.5.3.3")),
        ilstEntryBytes("trkn", 0, [0, 0, 0, 5, 0, 10, 0, 0]),
      ]))),
    ),
  );
  assert.equal(metadata.get("dc:title"), "A Title");
  assert.equal(metadata.get("xmpDM:artist"), "An Artist");
  assert.equal(metadata.get("dc:creator"), "An Artist");
  assert.equal(metadata.get("xmp:CreatorTool"), "iTunes 10.5.3.3");
  assert.equal(metadata.get("xmpDM:trackNumber"), "5");
  assert.equal(metadata.get("audio:track-count"), "10");
});

test("reads the year form of ©day as xmpDM:releaseDate", async () => {
  const metadata = await parseMp4(
    movie(
      mvhd(0, 0, 0, 1000, 1000),
      udta(metaBox("mdir", ilst([ilstEntryBytes("©day", 1, text("2008"))]))),
    ),
  );
  assert.equal(metadata.get("xmpDM:releaseDate"), "2008");
});

test("rejects files without moov", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array(16));
  await assert.rejects(
    new Mp4Parser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
});
