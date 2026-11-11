import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";
import { detectOgg } from "../src/containers/ogg.ts";

/*
 * The detection half of the parity-gap beads tikajs-68os.15, .17 and .18: every media type string those beads name
 * that is reached from bytes. Each case is synthetic bytes built from the magic Tika 4.2.0 declares (line numbers are
 * those of tika-core/src/main/resources/org/apache/tika/mime/tika-mimetypes.xml), read from the Tika source and not
 * run against a Tika. The parsers that claim these types are tracked by the beads and are not part of detection.
 */

const detector = new DefaultDetector();
const encoder = new TextEncoder();

async function detect(bytes: Uint8Array, filename = "x.bin"): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const metadata = new Metadata();
    metadata.set("tk:resource-name", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

async function failures(cases: ReadonlyArray<readonly [string, Uint8Array, string]>, filename?: string): Promise<string[]> {
  const found: string[] = [];
  for (const [label, bytes, expected] of cases) {
    const actual = await detect(bytes, filename);
    if (actual !== expected) found.push(`${label}: expected ${expected}, got ${actual}`);
  }
  return found;
}

/** Zero-filled bytes with the given bytes written at the given offsets. */
function bytesWith(length: number, ...writes: ReadonlyArray<readonly [number, ArrayLike<number>]>): Uint8Array {
  const bytes = new Uint8Array(length);
  for (const [offset, value] of writes) bytes.set(value, offset);
  return bytes;
}

function u32(value: number, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, littleEndian);
  return bytes;
}

// tikajs-68os.18 ----------------------------------------------------------------------------------------------------

test("BIFF2-4 spreadsheets, charts and macros, and BIFF3-4 workspaces, are their own Excel types (xml 2124-2175)", async () => {
  // A BIFF record header (version bytes at 0), then the substream kind at 4: sheet, chart or macro.
  const kinds: ReadonlyArray<readonly [string, number[]]> = [
    ["sheet", [0x00, 0x00, 0x10, 0x00]],
    ["chart", [0x00, 0x00, 0x20, 0x00]],
    ["macro", [0x00, 0x00, 0x40, 0x00]],
  ];
  const headers: ReadonlyArray<readonly [string, number[], string]> = [
    ["BIFF2", [0x09, 0x00, 0x04, 0x00], "application/vnd.ms-excel.sheet.2"],
    ["BIFF3", [0x09, 0x02, 0x06, 0x00], "application/vnd.ms-excel.sheet.3"],
    ["BIFF4", [0x09, 0x04, 0x06, 0x00], "application/vnd.ms-excel.sheet.4"],
  ];
  const cases: Array<[string, Uint8Array, string]> = [];
  for (const [version, header, type] of headers) {
    for (const [kind, marker] of kinds) cases.push([`${version} ${kind}`, bytesWith(32, [0, header], [4, marker]), type]);
  }
  // BIFF2 has no workspace; BIFF3 and BIFF4 mark one with 0x00000001 at 4.
  cases.push(["BIFF3 workspace", bytesWith(32, [0, [0x09, 0x02, 0x06, 0x00]], [4, [0, 0, 0, 1]]), "application/vnd.ms-excel.workspace.3"]);
  cases.push(["BIFF4 workspace", bytesWith(32, [0, [0x09, 0x04, 0x06, 0x00]], [4, [0, 0, 0, 1]]), "application/vnd.ms-excel.workspace.4"]);
  assert.deepEqual(await failures(cases), []);
});

// tikajs-68os.17 ----------------------------------------------------------------------------------------------------

test("every Mach-O file type is its own type, in all four header byte orders and widths (xml 4509-4700)", async () => {
  // mach_header: magic at 0, file type (filetype) as a 32-bit word at 12 in the file's own byte order.
  const fileTypes: ReadonlyArray<readonly [number, string]> = [
    [1, "application/x-mach-o-object"],
    [2, "application/x-mach-o-executable"],
    [3, "application/x-mach-o-fvmlib"],
    [4, "application/x-mach-o-core"],
    [5, "application/x-mach-o-preload"],
    [6, "application/x-mach-o-dylib"],
    [7, "application/x-mach-o-dylinker"],
    [8, "application/x-mach-o-bundle"],
    [9, "application/x-mach-o-dylib-stub"],
    [10, "application/x-mach-o-dsym"],
    [11, "application/x-mach-o-kext-bundle"],
  ];
  const magics: ReadonlyArray<readonly [string, number[], boolean]> = [
    ["32-bit big-endian", [0xfe, 0xed, 0xfa, 0xce], false],
    ["32-bit little-endian", [0xce, 0xfa, 0xed, 0xfe], true],
    ["64-bit big-endian", [0xfe, 0xed, 0xfa, 0xcf], false],
    ["64-bit little-endian", [0xcf, 0xfa, 0xed, 0xfe], true],
  ];
  const cases: Array<[string, Uint8Array, string]> = [];
  for (const [order, magic, little] of magics) {
    for (const [fileType, type] of fileTypes) cases.push([`${order} filetype ${fileType}`, bytesWith(32, [0, magic], [12, u32(fileType, little)]), type]);
    // A file type Tika has no rule for stays the generic Mach-O type.
    cases.push([`${order} filetype 12`, bytesWith(32, [0, magic], [12, u32(12, little)]), "application/x-mach-o"]);
  }
  assert.deepEqual(await failures(cases), []);
});

test("a fat (universal) Mach-O file is application/x-mach-o-universal, a Java class file is not (xml 446-470)", async () => {
  const cases: Array<[string, Uint8Array, string]> = [];
  for (const architectures of [1, 2, 0x13]) {
    cases.push([`CAFEBABE, ${architectures} architectures`, bytesWith(64, [0, [0xca, 0xfe, 0xba, 0xbe]], [4, u32(architectures, false)]), "application/x-mach-o-universal"]);
    cases.push([`BEBAFECA, ${architectures} architectures`, bytesWith(64, [0, [0xbe, 0xba, 0xfe, 0xca]], [4, u32(architectures, true)]), "application/x-mach-o-universal"]);
    cases.push([`CAFEBABF, ${architectures} architectures`, bytesWith(64, [0, [0xca, 0xfe, 0xba, 0xbf]], [4, u32(architectures, false)]), "application/x-mach-o-universal"]);
  }
  // Minor version 0, major version 52 (Java 8): not a count of architectures.
  cases.push(["Java 8 class file", bytesWith(64, [0, [0xca, 0xfe, 0xba, 0xbe]], [4, [0, 0, 0, 0x34]]), "application/java-vm"]);
  assert.deepEqual(await failures(cases), []);
});

test("ELF relocatable, executable, shared object and core file are their own types, in either byte order (xml 4032-4135)", async () => {
  const elf = (type: number, littleEndian: boolean): Uint8Array =>
    bytesWith(64, [0, [0x7f, 0x45, 0x4c, 0x46, 2, littleEndian ? 1 : 2, 1]], [16, littleEndian ? [type, 0] : [0, type]]);
  const cases: Array<[string, Uint8Array, string]> = [];
  for (const littleEndian of [true, false]) {
    const order = littleEndian ? "little-endian" : "big-endian";
    cases.push([`${order} relocatable`, elf(1, littleEndian), "application/x-object"]);
    cases.push([`${order} executable`, elf(2, littleEndian), "application/x-executable"]);
    cases.push([`${order} shared object`, elf(3, littleEndian), "application/x-sharedlib"]);
    cases.push([`${order} core`, elf(4, littleEndian), "application/x-coredump"]);
    cases.push([`${order} other type`, elf(5, littleEndian), "application/x-elf"]);
  }
  assert.deepEqual(await failures(cases), []);
});

// tikajs-68os.15 ----------------------------------------------------------------------------------------------------

test("au, MIDI, M4V and HEIF sequence magic name their types (xml 5974, 6036, 6696, 7069, 7076, 9020)", async () => {
  const brand = (value: string): Uint8Array => bytesWith(32, [0, u32(32, false)], [4, encoder.encode(`ftyp${value}`)]);
  const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
    ["MIDI header chunk", encoder.encode("MThd\0\0\0\x06\0\0\0\x01\0\x60"), "audio/midi"],
    // Rule 2 of audio/basic: ".snd" and three zero bytes. Rule 1: ".snd" and an encoding of 1-7 at 12.
    ["au, zero-padded header", bytesWith(32, [0, encoder.encode(".snd")]), "audio/basic"],
    ["au, encoding 1 at 12", bytesWith(32, [0, encoder.encode(".snd")], [4, [1, 0, 0, 0]], [12, u32(1, false)]), "audio/basic"],
    ["au, encoding 7 at 12", bytesWith(32, [0, encoder.encode(".snd")], [4, [1, 0, 0, 0]], [12, u32(7, false)]), "audio/basic"],
    ["M4V brand", brand("M4V "), "video/x-m4v"],
    ["M4V high-profile brand", brand("M4VH"), "video/x-m4v"],
    ["M4V portable brand", brand("M4VP"), "video/x-m4v"],
    ["HEVC image sequence", brand("hevc"), "image/heic-sequence"],
    ["HEVC multi-layer image sequence", brand("hevx"), "image/heic-sequence"],
    ["generic HEIF image sequence", brand("msf1"), "image/heif-sequence"],
  ];
  assert.deepEqual(await failures(cases), []);
});

test("an au header whose encoding is not 1-7 and whose padding is not zero is not audio/basic", async () => {
  const bytes = bytesWith(32, [0, encoder.encode(".snd")], [4, [1, 0, 0, 0]], [12, u32(8, false)]);
  assert.notEqual(await detect(bytes), "audio/basic");
});

test("application/mp4 and audio/midi come from names alone, and the MP4-family magic is not turned into them (xml 687, 6036)", async () => {
  // `application/mp4` has only the glob *.mp4s: it is no specialization of the video type an ftyp names.
  const binary = Uint8Array.of(0x00, 0x01, 0x02, 0xff, 0xfe, 0x00);
  assert.equal(await detect(binary, "x.mp4s"), "application/mp4");
  assert.equal(await detect(binary, "x.midi"), "audio/midi");
  assert.equal(await detect(bytesWith(32, [0, u32(32, false)], [4, encoder.encode("ftypisom")]), "x.mp4s"), "video/quicktime");
});

/** A single beginning-of-stream Ogg page whose first packet is `packet`. */
function oggStream(serial: number, packet: Uint8Array): Uint8Array {
  const page = new Uint8Array(27 + 1 + packet.length);
  page.set(encoder.encode("OggS"), 0);
  page[5] = 0x02;
  new DataView(page.buffer).setUint32(14, serial, true);
  page[26] = 1;
  page[27] = packet.length;
  page.set(packet, 28);
  return page;
}

function oggFile(...streams: readonly Uint8Array[]): Uint8Array {
  const file = new Uint8Array(streams.reduce((sum, stream) => sum + stream.length, 0));
  let offset = 0;
  for (const stream of streams) {
    file.set(stream, offset);
    offset += stream.length;
  }
  return file;
}

function packetOf(signature: string, length: number): Uint8Array {
  const packet = new Uint8Array(length);
  packet.set(Buffer.from(signature, "latin1"), 0);
  return packet;
}

test("the Ogg detector names a file for its one video stream, and mixed video is video/ogg (OggDetector.java:188-209)", () => {
  // The Ogg detector alone: in the full detector the registry's magic then refines these to the first stream's type.
  const theora = (serial: number): Uint8Array => oggStream(serial, packetOf("\x80theora", 30));
  const daala = (serial: number): Uint8Array => oggStream(serial, packetOf("\x80daala", 30));
  const dirac = (serial: number): Uint8Array => oggStream(serial, packetOf("BBCD", 30));
  const vorbis = (serial: number): Uint8Array => oggStream(serial, packetOf("\x01vorbis", 30));
  const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
    ["daala alone", oggFile(daala(1)), "video/daala"],
    ["dirac alone", oggFile(dirac(1)), "video/x-dirac"],
    ["two theora streams", oggFile(theora(1), theora(2)), "video/theora"],
    ["theora and daala", oggFile(theora(1), daala(2)), "video/ogg"],
    ["theora, dirac and vorbis", oggFile(theora(1), dirac(2), vorbis(3)), "video/ogg"],
    ["one video stream and two audio", oggFile(daala(1), vorbis(2), vorbis(3)), "video/daala"],
  ];
  const wrong = cases.flatMap(([label, bytes, expected]) => {
    const actual = detectOgg(bytes)?.toString();
    return actual === expected ? [] : [`${label}: expected ${expected}, got ${actual}`];
  });
  assert.deepEqual(wrong, []);
});

test("the Ogg detector identifies OGM and Ogg RGB video streams (tikajs-68os.62)", () => {
  // The packet starts are the OGM header (a type byte of 1, then "video") and the raw RGB mapping (1, "RGB"), as the
  // detector's siblings for raw YUV and UVS do. The registry (xml 8888-8931) names the same two types.
  const ogm = (serial: number): Uint8Array => oggStream(serial, packetOf("\x01video\0\0\0", 57));
  const rgb = (serial: number): Uint8Array => oggStream(serial, packetOf("\x01RGB", 30));
  const vorbis = (serial: number): Uint8Array => oggStream(serial, packetOf("\x01vorbis", 30));
  const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
    ["ogm alone", oggFile(ogm(1)), "video/x-ogm"],
    ["rgb alone", oggFile(rgb(1)), "video/x-oggrgb"],
    ["ogm and vorbis", oggFile(ogm(1), vorbis(2)), "video/x-ogm"],
    ["two ogm streams", oggFile(ogm(1), ogm(2)), "video/x-ogm"],
    ["ogm and rgb", oggFile(ogm(1), rgb(2)), "video/ogg"],
  ];
  const wrong = cases.flatMap(([label, bytes, expected]) => {
    const actual = detectOgg(bytes)?.toString();
    return actual === expected ? [] : [`${label}: expected ${expected}, got ${actual}`];
  });
  assert.deepEqual(wrong, []);
});

test("an OGM or Ogg RGB packet counts from 28 bytes, as the raw YUV and UVS packets beside them do", () => {
  const cases: ReadonlyArray<readonly [string, string, number, string]> = [
    ["ogm of 27", "\x01video", 27, "application/ogg"],
    ["ogm of 28", "\x01video", 28, "video/x-ogm"],
    ["rgb of 27", "\x01RGB", 27, "application/ogg"],
    ["rgb of 28", "\x01RGB", 28, "video/x-oggrgb"],
    ["yuv of 27", "\x01YUV", 27, "application/ogg"],
    ["yuv of 28", "\x01YUV", 28, "video/x-oggyuv"],
  ];
  const wrong = cases.flatMap(([label, signature, length, expected]) => {
    const actual = detectOgg(oggFile(oggStream(1, packetOf(signature, length))))?.toString();
    return actual === expected ? [] : [`${label}: expected ${expected}, got ${actual}`];
  });
  assert.deepEqual(wrong, []);
});

test("in the full detector the registry's Ogg magic refines mixed video to the first stream's type", async () => {
  const theora = oggStream(1, packetOf("\x80theora", 30));
  const daala = oggStream(2, packetOf("\x80daala", 30));
  assert.equal(await detect(oggFile(theora, daala)), "video/theora");
  assert.equal(await detect(oggFile(daala, theora)), "video/daala");
});

test("Ogg streams Tika's identifier does not know are application/ogg, and Ogg magic in the registry can still refine them (xml 8888-8930)", async () => {
  const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
    ["unidentified stream", oggFile(oggStream(1, packetOf("zzzzzzz", 30))), "application/ogg"],
    // The registry's masked magic for an OGM or raw-RGB stream puts its marker right after the page header.
    ["registry OGM marker", oggFile(oggStream(1, packetOf("video", 30))), "video/x-ogm"],
    ["registry raw RGB marker", oggFile(oggStream(1, packetOf("\x01RGB", 30))), "video/x-oggrgb"],
  ];
  assert.deepEqual(await failures(cases), []);
});
