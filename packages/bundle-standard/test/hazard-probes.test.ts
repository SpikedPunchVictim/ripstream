import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { crc32 } from "node:zlib";
import { MemoryPool, type PoolStats, type RunDiagnostics } from "@spikedpunch/ripstream-isolation-node";
import { RipstreamError } from "../src/index.ts";
import { createStandardIsolation, type StandardIsolation } from "../src/isolation.ts";

/**
 * The two hazard-list libraries that had not been probed (zgg2.8, P6), through the REAL isolator: music-metadata
 * (AudioParser) and hyparquet (ColumnarParser). Every hostile input here is built in memory from a few bytes of recipe;
 * no binary is committed. Each hazard test asserts the CONTAINED outcome: a typed failure (or, where the library
 * legitimately finishes, success), one child that is dead before its caller is answered, a bounded time, a whole pool,
 * no unreaped child, and an isolator that still serves the next request. It does not assert exact messages.
 *
 * Measured on macOS (Darwin 25.3, arm64, Node 24.18) and on Linux (docker node:24-slim, arm64, kernel 7.0 linuxkit,
 * Node 24.22.2; the numbers below are macOS unless a line says Linux), music-metadata 12.3.4, hyparquet 1.17.1. "bare" is the same
 * file parsed in-process by createRipstream() in a throwaway child with Node's default heap; "tight" is this file's
 * isolator (perChildMb 256, heapMb 64, maxTaskMillis 10 s); "default" is perChildMb 1536, derived heap (~385 MiB),
 * maxTaskMillis 15 s.
 *
 *   music-metadata (it already caps allocations at 64 MiB and metadata entries at 100,000, so a lying length field
 *   is a cheap MALFORMED_DOCUMENT; the cost is elsewhere)
 *     0xFF x 2 MiB as an MP3 (every byte is a sync candidate): bare 6.1 s, 272 MiB RSS (about 70 bytes of heap per
 *       input byte, 3 s of CPU per MiB, linear: 1 MiB 3.5 s, 4 MiB 12.4 s, 8 MiB did not finish in 20 s).
 *       tight: LIMIT_EXCEEDED by the heap cap (SIGABRT) after 4.6 s. default: ok after 7.1 s, child RSS 274 MiB.
 *       8 MiB, default, maxTaskMillis 15 s: PARSE_TIMEOUT, killReason timeout, 15.4 s.
 *     free-format MPEG headers x 2 MiB: bare 3.5 s, 180 MiB. tight: ok after 4.2 s.
 *     100,000 CHAP frames (2.8 MiB): bare 209 MiB; tight: LIMIT_EXCEEDED (heap, SIGABRT) after 1.0 s.
 *     85,000 tiny APIC frames (2 MiB): bare 1.3 s, 202 MiB; tight: ok after 2.0 s.
 *   Not reachable through the bundle: Ogg Vorbis / Opus detect as audio/vorbis and audio/opus, which no parser
 *   claims (UNSUPPORTED_FORMAT), and no detector output maps to the AudioParser type audio/ogg. Probed with
 *   music-metadata directly: all bounded, under 20 ms. ASF/WMA detects as video/x-ms-asf (another parser).
 *
 *   hyparquet (no limits of its own; the ColumnarParser asks for rows 0..100 of every column of the first row groups)
 *     dictionary page + data page of 2^31-1 values with bit width 0 (119 bytes): bare 4.1 s, 1.0 GiB, ok (it
 *       allocated an Int32Array of 2^31-1 and filled it). tight: LIMIT_EXCEEDED by the RSS poll (child 783 MiB
 *       against 256). default (macOS): OK after 5.6 s, child RSS 895 MiB, inside its 1536 MiB budget (see the
 *       todo at the end of this file). The BYTE_ARRAY variant crashes bare with SIGABRT after 7 s and 1.1 GiB.
 *     one RLE run of 2^31-1 levels (117 bytes): bare 3.5 s, 1.6 GiB; tight: LIMIT_EXCEEDED (heap) after 0.8 s.
 *     DELTA_BINARY_PACKED with 2^31-1 values and a bit-width-0 miniblock (118 bytes): bare did not finish in 20 s;
 *       tight: LIMIT_EXCEEDED by RSS after 1.3 s; default: PARSE_TIMEOUT after 15.5 s.
 *     schema with 20,000 columns and one row group, 757 KB: getSchemaPath rebuilds the whole schema tree for every
 *       column, so the cost is quadratic: 5,000 columns 2.4 s, 10,000 9.4 s, 20,000 and 40,000 did not finish in 20 s
 *       (bare). tight: LIMIT_EXCEEDED by the heap after 1.0 s. default: LIMIT_EXCEEDED by the CPU limit (SIGXCPU)
 *       after 7.3 s.
 *     3,000 nested schema groups (24 KB): bare 236 MiB (path arrays copied at every level); tight: LIMIT_EXCEEDED.
 *     1.9 million one-byte empty structs as the schema list: bare 722 MiB; tight: LIMIT_EXCEEDED.
 *   Everything else probed (footer length 1 GiB, list size 2^31-1, 1 MiB of struct nesting, 2 GiB uncompressed page
 *   size with snappy, 2 GiB dictionary num_values, snappy copy expansion, num_rows 2^62) was a fast typed failure or a
 *   clean success.
 *
 * Linux differs where the child has more layers (L4 `ulimit -v`, a 20 ms /proc RSS poll): the three multi-GiB typed
 * array cases (both dictionary pages and the delta page) are refused by the allocator itself, a catchable RangeError in the
 * child, and answered MALFORMED_DOCUMENT in 0.5 - 4 s with no kill and a child RSS of 110 MiB (HUGE_ARRAY below). The
 * CHAP-frame file survives its 64 MiB heap there (ok, 205 MiB RSS). The 20,000-column file ends in PARSE_TIMEOUT at
 * 3.1 s with loose limits instead of SIGXCPU.
 *
 * Why the heap/RSS numbers are not the whole story: the tight limits make the memory layers fire first, which is what
 * keeps this file fast. The CPU-bound hazards are also covered with limits loose enough that only the clock
 * (PARSE_TIMEOUT) or the CPU limit can end them.
 */

const MIB = 1024 * 1024;

interface Config {
  readonly mode: "strict";
  readonly perChildMb: number;
  readonly heapMb: number;
  readonly maxTaskMillis: number;
}
const TIGHT: Config = { mode: "strict", perChildMb: 256, heapMb: 64, maxTaskMillis: 10_000 };
/** Memory is not the binding limit here: only the clock (or the CPU limit) can end a CPU-bound parse. */
const CLOCK_ONLY: Config = { mode: "strict", perChildMb: 2048, heapMb: 1024, maxTaskMillis: 3000 };

// ---- byte helpers ----------------------------------------------------------------------------------------------------

const cat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);
const rep = (part: Buffer, times: number): Buffer => Buffer.concat(Array.from({ length: times }, () => part));
const u8 = (...n: number[]): Buffer => Buffer.from(n);
const u16be = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u32be = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const ascii = (s: string): Buffer => Buffer.from(s, "latin1");
const zeros = (n: number): Buffer => Buffer.alloc(n);

// ---- music-metadata fixtures -----------------------------------------------------------------------------------------

const syncsafe = (n: number): Buffer => u8((n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f);
/** An ID3v2 tag whose size field says `declaredSize` (default: the real size of `frames`). */
function id3v2(version: 3 | 4, frames: Buffer, declaredSize = frames.length): Buffer {
  return cat(ascii("ID3"), u8(version, 0, 0), syncsafe(declaredSize), frames);
}
const id3Frame = (id: string, body: Buffer): Buffer => cat(ascii(id), u32be(body.length), u16be(0), body);
/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono: 417 bytes per frame. */
const mp3Frames = (count: number): Buffer => rep(cat(u8(0xff, 0xfb, 0x90, 0xc0), zeros(413)), count);

const validMp3 = (): Buffer => cat(id3v2(3, id3Frame("TIT2", cat(u8(0), ascii("Title")))), mp3Frames(200));
/** A 105 KB file whose ID3v2 header declares a 250 MiB tag. */
const id3TagSizeLie = (): Buffer => cat(id3v2(4, zeros(64 * 1024), 250 * MIB), mp3Frames(100));
/** `megabytes` MiB of 0xFF after an empty ID3v2 tag: every byte looks like the start of an MPEG sync word. */
const syncSpam = (megabytes: number): Buffer => cat(id3v2(3, Buffer.alloc(0)), Buffer.alloc(megabytes * MIB, 0xff));
/** 0xFF 0xFB 0x00 0xC0 repeated: valid-looking headers with bitrate index 0 (free format), so no frame length. */
const freeFormatHeaders = (): Buffer => cat(id3v2(3, Buffer.alloc(0)), rep(u8(0xff, 0xfb, 0x00, 0xc0), 500_000));
const chapFrames = (count: number): Buffer => cat(id3v2(3, rep(id3Frame("CHAP", cat(ascii("c"), u8(0), zeros(16))), count)), mp3Frames(10));
const apicFrames = (count: number): Buffer =>
  cat(id3v2(3, rep(id3Frame("APIC", cat(u8(0), ascii("image/png"), u8(0), u8(3), u8(0), u8(0x89))), count)), mp3Frames(10));

// ---- hyparquet fixtures (hand-built Thrift compact protocol) ---------------------------------------------------------

const T = { I32: 5, I64: 6, BINARY: 8, LIST: 9, STRUCT: 12 } as const;
const PT = { INT32: 1, INT64: 2, BYTE_ARRAY: 6 } as const;
const ENC = { PLAIN: 0, RLE: 3, DELTA_BINARY_PACKED: 5, RLE_DICTIONARY: 8 } as const;

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}
const zigzag32 = (n: number): Buffer => varint((n << 1) ^ (n >> 31));
const zigzag64 = (n: number): Buffer => {
  let v = BigInt.asUintN(64, (BigInt(n) << 1n) ^ (BigInt(n) >> 63n));
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
};

type Field = readonly [fid: number, type: number, payload: Buffer];
const fi32 = (fid: number, v: number): Field => [fid, T.I32, zigzag32(v)];
const fi64 = (fid: number, v: number): Field => [fid, T.I64, zigzag64(v)];
const fbin = (fid: number, s: string): Field => [fid, T.BINARY, cat(varint(s.length), ascii(s))];
const fstruct = (fid: number, fields: readonly Field[]): Field => [fid, T.STRUCT, struct(fields)];
const flist = (fid: number, elemType: number, items: readonly Buffer[]): Field => {
  const size = items.length;
  const head = size < 15 ? u8((size << 4) | elemType) : cat(u8(0xf0 | elemType), varint(size));
  return [fid, T.LIST, Buffer.concat([head, ...items])];
};
/** A list<struct> of `count` empty structs (one byte each): the smallest possible amplification unit. */
const fEmptyStructs = (fid: number, count: number): Field => [fid, T.LIST, cat(u8(0xf0 | T.STRUCT), varint(count), zeros(count))];

function struct(fields: readonly Field[]): Buffer {
  const parts: Buffer[] = [];
  let last = 0;
  for (const [fid, type, payload] of fields) {
    parts.push(u8(((fid - last) << 4) | type), payload);
    last = fid;
  }
  parts.push(u8(0));
  return Buffer.concat(parts);
}

const schemaRoot = (children: number): Buffer => struct([fbin(4, "schema"), fi32(5, children)]);
const schemaLeaf = (name: string, type: number, repetition: number): Buffer => struct([fi32(1, type), fi32(3, repetition), fbin(4, name)]);
const schemaGroup = (name: string): Buffer => struct([fi32(3, 0), fbin(4, name), fi32(5, 1)]);

function pageHeader(type: number, size: number, dataPage?: { numValues: number; encoding: number }, dictValues?: number): Buffer {
  const fields: Field[] = [fi32(1, type), fi32(2, size), fi32(3, size)];
  if (dataPage) fields.push(fstruct(5, [fi32(1, dataPage.numValues), fi32(2, dataPage.encoding), fi32(3, ENC.RLE), fi32(4, ENC.RLE)]));
  if (dictValues !== undefined) fields.push(fstruct(7, [fi32(1, dictValues), fi32(2, ENC.PLAIN)]));
  return struct(fields);
}
const dataPage = (numValues: number, encoding: number, body: Buffer): Buffer => cat(pageHeader(0, body.length, { numValues, encoding }), body);
const dictPage = (numValues: number, body: Buffer): Buffer => cat(pageHeader(2, body.length, undefined, numValues), body);

function columnChunk(name: string, type: number, numValues: number, dataOffset: number, compressed: number, dictOffset?: number): Buffer {
  return struct([
    fi64(2, dataOffset),
    fstruct(3, [
      fi32(1, type),
      flist(2, T.I32, [zigzag32(ENC.PLAIN)]),
      flist(3, T.BINARY, [cat(varint(name.length), ascii(name))]),
      fi32(4, 0),
      fi64(5, numValues),
      fi64(6, compressed),
      fi64(7, compressed),
      fi64(9, dataOffset),
      ...(dictOffset === undefined ? [] : [fi64(11, dictOffset)]),
    ]),
  ]);
}
const rowGroup = (chunks: Buffer[], numRows: number): Buffer => struct([flist(1, T.STRUCT, chunks), fi64(2, 0), fi64(3, numRows)]);
const fileMeta = (schema: Field, numRows: number, groups: Buffer[]): Buffer =>
  struct([fi32(1, 1), schema, fi64(3, numRows), flist(4, T.STRUCT, groups), fbin(6, "probe")]);
const parquetFile = (body: Buffer, meta: Buffer): Buffer => cat(ascii("PAR1"), body, meta, u32le(meta.length), ascii("PAR1"));

const int32s = (...v: number[]): Buffer => Buffer.concat(v.map(u32le));

/** One required INT32 column "a" with the values 1, 2, 3. */
function validParquet(): Buffer {
  const body = dataPage(3, ENC.PLAIN, int32s(1, 2, 3));
  const meta = fileMeta(flist(2, T.STRUCT, [schemaRoot(1), schemaLeaf("a", PT.INT32, 0)]), 3, [rowGroup([columnChunk("a", PT.INT32, 3, 4, body.length)], 3)]);
  return parquetFile(body, meta);
}
/** The same file with the footer length field rewritten to 1 GiB. */
function footerLengthLie(): Buffer {
  const file = validParquet();
  file.writeUInt32LE(1 << 30, file.length - 8);
  return file;
}
/** One column of `type` whose chunk is `body` (pages already encoded; a dictionary page, if any, comes first). */
function singleColumn(type: number, repetition: number, body: Buffer, dictLength?: number): Buffer {
  const chunk = columnChunk("a", type, 3, dictLength === undefined ? 4 : 4 + dictLength, body.length, dictLength === undefined ? undefined : 4);
  return parquetFile(body, fileMeta(flist(2, T.STRUCT, [schemaRoot(1), schemaLeaf("a", type, repetition)]), 3, [rowGroup([chunk], 3)]));
}
/**
 * A dictionary page of one value, then a data page of 2^31-1 RLE_DICTIONARY values whose bit width byte is 0. A bit
 * width of 0 means "all zeros" and needs no data, so the page is a single byte; hyparquet allocates and fills the
 * whole expanded array (Int32Array: 8 GiB; BYTE_ARRAY dictionary: a 2 GiB Uint8Array).
 */
function dictionaryBitWidthZero(type: number): Buffer {
  const dict = type === PT.INT32 ? dictPage(1, int32s(7)) : dictPage(1, cat(u32le(1), u8(0x41)));
  return singleColumn(type, 0, cat(dict, dataPage(0x7fffffff, ENC.RLE_DICTIONARY, u8(0))), dict.length);
}
/** An OPTIONAL column whose definition levels are ONE RLE run of 2^31-1 values, while the page holds 10. */
function hugeRleRun(): Buffer {
  const levels = cat(varint(0xfffffffe), u8(1));
  return singleColumn(PT.INT32, 1, dataPage(10, ENC.PLAIN, cat(u32le(levels.length), levels, int32s(1, 2, 3))));
}
/** DELTA_BINARY_PACKED INT32, 2^31-1 values, block size 2^30, bit width 0 (consumes no input per value). */
function deltaBitWidthZero(): Buffer {
  const body = cat(varint(1 << 30), u8(1), varint(0x7fffffff), zeros(10));
  return singleColumn(PT.INT32, 0, dataPage(0x7fffffff, ENC.DELTA_BINARY_PACKED, body));
}
/** `columns` INT32 columns that all point at the same 3-value page. Unique names, so every name lookup is a real search. */
function wideSchema(columns: number): Buffer {
  const body = dataPage(3, ENC.PLAIN, int32s(1, 2, 3));
  const names = Array.from({ length: columns }, (_, i) => `c${i.toString(36)}`);
  const chunks = names.map((name) => columnChunk(name, PT.INT32, 3, 4, body.length));
  const schema = flist(2, T.STRUCT, [schemaRoot(columns), ...names.map((n) => schemaLeaf(n, PT.INT32, 0))]);
  return parquetFile(body, fileMeta(schema, 3, [rowGroup(chunks, 3)]));
}
/** A chain of `depth` single-child groups ending in one leaf, no row groups. */
function nestedGroups(depth: number): Buffer {
  const schema = flist(2, T.STRUCT, [schemaRoot(1), ...Array.from({ length: depth }, () => schemaGroup("g")), schemaLeaf("leaf", PT.INT32, 0)]);
  return parquetFile(Buffer.alloc(0), fileMeta(schema, 0, []));
}
/** A FileMetaData whose schema list is `count` empty structs: 1.9 MiB of file, millions of objects. */
function emptyStructSchema(count: number): Buffer {
  return parquetFile(Buffer.alloc(0), struct([fi32(1, 1), fEmptyStructs(2, count), fi64(3, 0), flist(4, T.STRUCT, [])]));
}

// ---- harness ---------------------------------------------------------------------------------------------------------

interface Harness {
  readonly standard: StandardIsolation;
  readonly runs: RunDiagnostics[];
}

/** A fresh pool and isolator per test, so the pool numbers asserted below belong to that test alone. */
async function withIsolator(
  config: Config,
  action: (harness: Harness) => Promise<void>,
  options: { readonly defaultMaxOutputChars?: number } = {},
): Promise<void> {
  const pool = new MemoryPool({ poolMb: 4096, maxQueue: 4 });
  const runs: RunDiagnostics[] = [];
  const standard = await createStandardIsolation({ config, pool, ...options, runner: { onRunSettled: (d) => runs.push(d) } });
  try {
    await action({ standard, runs });
  } finally {
    await standard.isolator.dispose();
    pool.dispose();
  }
}

/** The runner returns a child's pool lease when the child is DEAD, which can be a moment after its caller was answered. */
async function settledStatus(standard: StandardIsolation): Promise<{ pool: PoolStats; unreapedChildren: number }> {
  const deadline = performance.now() + 5000;
  for (;;) {
    const { pool, unreapedChildren } = standard.isolator.status();
    assert.ok(pool !== null, "an isolating isolator reports its pool");
    if ((pool.freeMb === pool.poolMb && unreapedChildren === 0) || performance.now() > deadline) return { pool, unreapedChildren };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function assertPoolReleased(status: { pool: PoolStats; unreapedChildren: number }): void {
  assert.deepEqual(
    { freeMb: status.pool.freeMb, reservedMb: status.pool.reservedMb, running: status.pool.running, queued: status.pool.queued },
    { freeMb: status.pool.poolMb, reservedMb: 0, running: 0, queued: 0 },
    "every MiB the hostile document's child reserved is back in the pool",
  );
  assert.equal(status.unreapedChildren, 0, "no child is left unreaped");
}

interface Probe {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly config: Config;
  /** Outcomes that count as contained: "ok" or a RipstreamError code. Anything else (crash, untyped error) fails. */
  readonly allowed: readonly string[];
  /** A valid document of the same library, parsed afterwards to prove the isolator still serves. */
  readonly control: { readonly bytes: Uint8Array; readonly filename: string };
  /** Slack on top of maxTaskMillis for the kill, the reap and the answer. */
  readonly graceMs?: number;
}

/** Parse `probe.bytes` in a child and assert that, however it ends, the parent and the pool are unharmed. */
async function assertContained(t: TestContext, probe: Probe): Promise<void> {
  await withIsolator(probe.config, async ({ standard, runs }) => {
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    let failure: unknown;
    try {
      await standard.ripstream.parse(probe.bytes, { filename: probe.filename });
    } catch (error) {
      failure = error;
    }
    const elapsedMs = performance.now() - started;
    const rssGrowthMb = (process.memoryUsage().rss - rssBefore) / MIB;

    // 1. A typed, HTTP-mappable failure or a clean success: never an untyped error, never a crash verdict.
    const outcome = failure === undefined ? "ok" : failure instanceof RipstreamError ? failure.code : `untyped: ${String(failure)}`;
    assert.equal(runs.length, 1, "the hostile document got exactly one child");
    const run = runs[0]!;
    t.diagnostic(
      `${probe.name} (${probe.bytes.length} bytes): ${outcome}; killReason ${String(run.killReason)}, signal ${String(run.signal)}, ` +
        `child peak RSS ${String(run.rss?.peakMb.toFixed(0))} MiB of ${probe.config.perChildMb}; ${elapsedMs.toFixed(0)} ms; parent RSS +${rssGrowthMb.toFixed(0)} MiB`,
    );
    assert.ok(probe.allowed.includes(outcome), `${probe.name}: outcome "${outcome}" is not one of ${probe.allowed.join(", ")}`);

    // 2. The child is gone before its caller was answered, and only the parent's own layers ended it.
    assert.equal(run.reaped, true, "the child was dead before its caller was answered");
    assert.equal(run.graceKilled, false);
    if (run.killReason !== null) assert.ok(run.killReason === "rss" || run.killReason === "timeout", `unexpected kill reason ${run.killReason}`);

    // 3. Bounded time.
    assert.ok(elapsedMs < probe.config.maxTaskMillis + (probe.graceMs ?? 5000), `took ${elapsedMs.toFixed(0)} ms of a ${probe.config.maxTaskMillis} ms budget`);

    // 4. The parent did not grow (coarse sanity bound: RSS is noisy, this only catches the parent doing the work).
    assert.ok(rssGrowthMb < 600, `parent RSS grew by ${rssGrowthMb.toFixed(0)} MiB`);

    // 5. Nothing left behind, and the isolator serves the next request in a new child.
    assertPoolReleased(await settledStatus(standard));
    await standard.ripstream.parse(probe.control.bytes, { filename: probe.control.filename });
    assert.equal(runs.length, 2, "the follow-up got its own child");
    assert.equal(runs[1]!.terminal, "done");
    assertPoolReleased(await settledStatus(standard));
  });
}

const AUDIO_CONTROL = { get bytes() { return validMp3(); }, filename: "after.mp3" };
const PARQUET_CONTROL = { get bytes() { return validParquet(); }, filename: "after.parquet" };

const LIMIT = "LIMIT_EXCEEDED";
const TIMEOUT = "PARSE_TIMEOUT";
const MALFORMED = "MALFORMED_DOCUMENT";

/**
 * Outcomes for a document that asks the parser for one multi-GiB typed array. macOS has no address-space limit: the
 * allocation succeeds and the parent's RSS poll ends the child (LIMIT_EXCEEDED, or PARSE_TIMEOUT if it were slow).
 * Linux has L4 (`ulimit -v`): the allocation itself throws RangeError inside the child, hyparquet's caller wraps that
 * as a parse failure, and the child answers in about half a second with MALFORMED_DOCUMENT and no kill. Contained
 * both ways, but the Linux code is arguably wrong (the document is within the format, it is the limit that refused it).
 */
const HUGE_ARRAY: readonly string[] = process.platform === "linux" ? [MALFORMED, LIMIT, TIMEOUT] : [LIMIT, TIMEOUT];

// ---- music-metadata (AudioParser) ------------------------------------------------------------------------------------

test("music-metadata control: a valid MP3 with an ID3v2 tag parses in a child", async (t) => {
  await assertContained(t, { name: "valid mp3", bytes: validMp3(), filename: "ok.mp3", config: TIGHT, allowed: ["ok"], control: AUDIO_CONTROL });
});

test("music-metadata control: an ID3v2 header declaring a 250 MiB tag is refused by the library as malformed (422)", async (t) => {
  await assertContained(t, { name: "250 MiB tag lie", bytes: id3TagSizeLie(), filename: "lie.mp3", config: TIGHT, allowed: [MALFORMED], control: AUDIO_CONTROL });
});

test("music-metadata: 2 MiB of 0xFF as an MP3 (about 3 s of CPU per MiB, about 70 bytes of heap per input byte) is contained", async (t) => {
  await assertContained(t, { name: "0xFF sync spam 2 MiB", bytes: syncSpam(2), filename: "spam.mp3", config: TIGHT, allowed: ["ok", LIMIT, TIMEOUT], control: AUDIO_CONTROL });
});

test("music-metadata: a CPU-bound MP3 (4 MiB of 0xFF, 12 s bare) with loose memory limits is ended by the clock, not by memory", async (t) => {
  await assertContained(t, {
    name: "0xFF sync spam 4 MiB, clock only",
    bytes: syncSpam(4),
    filename: "spam4.mp3",
    config: CLOCK_ONLY,
    // A machine four times faster would finish it inside 3 s and answer ok. The CPU limit (SIGXCPU, LIMIT_EXCEEDED) is
    // derived from the same 3 s and races the wall clock; either way the answer is bounded.
    allowed: ["ok", TIMEOUT, LIMIT],
    control: AUDIO_CONTROL,
  });
});

test("music-metadata: free-format MPEG headers (3.5 s bare) are contained", async (t) => {
  await assertContained(t, { name: "free-format headers 2 MiB", bytes: freeFormatHeaders(), filename: "free.mp3", config: TIGHT, allowed: ["ok", LIMIT, TIMEOUT], control: AUDIO_CONTROL });
});

test("music-metadata: 100,000 ID3v2 CHAP frames (2.8 MiB, about 200 MiB of heap bare) are contained", async (t) => {
  await assertContained(t, { name: "100k CHAP frames", bytes: chapFrames(100_000), filename: "chap.mp3", config: TIGHT, allowed: ["ok", LIMIT, TIMEOUT], control: AUDIO_CONTROL });
});

test("music-metadata: 85,000 tiny ID3v2 APIC frames (2 MiB, about 100 MiB of heap bare) are contained", async (t) => {
  await assertContained(t, { name: "85k APIC frames", bytes: apicFrames(85_000), filename: "apic.mp3", config: TIGHT, allowed: ["ok", LIMIT, TIMEOUT], control: AUDIO_CONTROL });
});

// ---- hyparquet (ColumnarParser) --------------------------------------------------------------------------------------

test("hyparquet control: a valid one-column Parquet file parses in a child", async (t) => {
  await assertContained(t, { name: "valid parquet", bytes: validParquet(), filename: "ok.parquet", config: TIGHT, allowed: ["ok"], control: PARQUET_CONTROL });
});

test("hyparquet control: a footer length field of 1 GiB is a fast malformed-document failure (422)", async (t) => {
  await assertContained(t, { name: "footer length 1 GiB", bytes: footerLengthLie(), filename: "lie.parquet", config: TIGHT, allowed: [MALFORMED], control: PARQUET_CONTROL });
});

test("hyparquet: a 119-byte file whose data page expands to 2^31-1 dictionary values (an 8 GiB Int32Array) is killed by memory", async (t) => {
  await assertContained(t, {
    name: "dictionary bit width 0, INT32",
    bytes: dictionaryBitWidthZero(PT.INT32),
    filename: "dict-int32.parquet",
    config: TIGHT,
    // Never "ok" under a 256 MiB budget: the array alone is 8 GiB.
    allowed: HUGE_ARRAY,
    control: PARQUET_CONTROL,
  });
});

test("hyparquet: the same page over a BYTE_ARRAY dictionary (a 2 GiB Uint8Array) is contained", async (t) => {
  await assertContained(t, {
    name: "dictionary bit width 0, BYTE_ARRAY",
    bytes: dictionaryBitWidthZero(PT.BYTE_ARRAY),
    filename: "dict-bytes.parquet",
    config: TIGHT,
    allowed: HUGE_ARRAY,
    control: PARQUET_CONTROL,
  });
});

test("hyparquet: one RLE run of 2^31-1 definition levels (117 bytes) is contained", async (t) => {
  await assertContained(t, { name: "RLE run 2^31-1", bytes: hugeRleRun(), filename: "rle.parquet", config: TIGHT, allowed: [LIMIT, TIMEOUT], control: PARQUET_CONTROL });
});

test("hyparquet: DELTA_BINARY_PACKED with 2^31-1 values and a bit-width-0 block (118 bytes) is contained", async (t) => {
  await assertContained(t, { name: "delta bit width 0", bytes: deltaBitWidthZero(), filename: "delta.parquet", config: TIGHT, allowed: HUGE_ARRAY, control: PARQUET_CONTROL });
});

test("hyparquet: 20,000 columns (757 KB; quadratic getSchemaPath) is contained", async (t) => {
  await assertContained(t, { name: "20,000 columns", bytes: wideSchema(20_000), filename: "wide.parquet", config: TIGHT, allowed: [LIMIT, TIMEOUT], control: PARQUET_CONTROL });
});

test("hyparquet: 20,000 columns with loose memory limits is ended by the CPU limit or the clock, not by memory", async (t) => {
  await assertContained(t, {
    name: "20,000 columns, clock only",
    bytes: wideSchema(20_000),
    filename: "wide-clock.parquet",
    config: CLOCK_ONLY,
    // 9.4 s for 10,000 columns bare, so 20,000 cannot finish in 3 s: the CPU limit (SIGXCPU, LIMIT_EXCEEDED) or the clock.
    allowed: [LIMIT, TIMEOUT],
    control: PARQUET_CONTROL,
  });
});

test("hyparquet: 3,000 nested schema groups (24 KB; every level copies its path) are contained", async (t) => {
  await assertContained(t, { name: "3,000 nested groups", bytes: nestedGroups(3000), filename: "nest.parquet", config: TIGHT, allowed: ["ok", LIMIT, TIMEOUT], control: PARQUET_CONTROL });
});

test("hyparquet: a schema list of 1.9 million empty structs (1.9 MiB, 700 MiB of heap bare) is contained", async (t) => {
  await assertContained(t, { name: "1.9M empty structs", bytes: emptyStructSchema(1_900_000), filename: "empty-structs.parquet", config: TIGHT, allowed: [LIMIT, TIMEOUT], control: PARQUET_CONTROL });
});

// ---- a 10,000-entry archive (the unit of work the isolator budgets in whole documents) -------------------------------

/** A ZIP with every entry stored (method 0), so a megabyte of archive is 10,000 real central-directory entries. */
function storedZip(entries: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

/**
 * The documented defaults (perChildMb 1536, maxTaskMillis 60 s; the heap is derived, about 385 MiB). The design
 * extrapolated roughly 58 - 60 s for the largest archive the central-directory walk admits (10,000 entries), i.e. the
 * whole default task budget. Measured: 2 - 3 s in ONE child (macOS 2.0 s, Linux 3.0 s, child RSS about 200 MiB), because
 * the entries are parsed in that child's own process, not one child per entry. The nearest real worst case is
 * different in kind: 4,990 nested archives of one binary entry each (9,981 documents, just under the 10,000 embedded
 * resource cap) cost about 1.4 ms per document, 13 s on macOS and 14 s on Linux, 221 - 266 MiB; that is still a fifth
 * of the budget, so no layer fires. Left out of this file for time.
 */
const DEFAULT_LIKE: Config = { mode: "strict", perChildMb: 1536, heapMb: 384, maxTaskMillis: 60_000 };

test("zip: a 10,000-entry archive is parsed recursively in one child in seconds, far inside the 60 s default budget", async (t) => {
  // One-character entries keep the text small, and a raised output cap keeps the 100,000-character default cap (which
  // would end this parse after about 1.5 s with LIMIT_EXCEEDED) from hiding the cost of the walk itself.
  const outputCap = 5_000_000;
  const entries = Array.from({ length: 10_000 }, (_, i) => [`f${String(i).padStart(5, "0")}.txt`, ascii("a")] as const);
  const archive = storedZip(entries);
  await withIsolator(
    DEFAULT_LIKE,
    async ({ standard, runs }) => {
      const started = performance.now();
      const records = await standard.ripstream.parseRecursive(archive, { filename: "ten-thousand.zip", limits: { maxOutputChars: outputCap } });
      const elapsedMs = performance.now() - started;
      const run = runs[0]!;
      t.diagnostic(`10,000 entries (${archive.length} bytes): ${records.length} records in ${elapsedMs.toFixed(0)} ms; child peak RSS ${String(run.rss?.peakMb.toFixed(0))} MiB`);
      assert.equal(runs.length, 1, "one child for the whole archive");
      assert.equal(records.length, 10_001, "the archive and every one of its entries");
      assert.equal(records.filter((record) => record.exception !== null).length, 0);
      assert.equal(run.terminal, "done");
      assert.equal(run.killReason, null);
      // 60 s is the budget; about 3 s is the measurement. 25 s is a loose bound that still fails a 10x regression.
      assert.ok(elapsedMs < 25_000, `took ${elapsedMs.toFixed(0)} ms`);
      assertPoolReleased(await settledStatus(standard));
    },
    { defaultMaxOutputChars: outputCap },
  );
});

// ---- not contained ----------------------------------------------------------------------------------------------------

test.todo(
  "tikajs-ubpo, tikajs-5bg6: hyparquet on macOS with the DEFAULT limits: the 119-byte bit-width-0 dictionary page is NOT ended by the memory layer. " +
    "Measured (Darwin 25.3, Node 24.18, perChildMb 1536, no heapMb): the parse finished ok after 4.5 - 5.6 s, `ps` RSS peaked at " +
    "804 - 895 MiB, but `footprint` (phys_footprint, which includes compressed pages) peaked at 9,574 MiB: " +
    "the child filled an 8 GiB Int32Array, which the macOS memory compressor squeezed out of sight of the ps-based " +
    "RSS poll. Six times its budget, with no limit firing, and any machine with less than about 10 GiB free swaps. Expected: " +
    "LIMIT_EXCEEDED. Linux is contained (RLIMIT_AS, MALFORMED_DOCUMENT in 4 s). Fix options: refuse a data page whose num_values " +
    "exceeds what its bytes can hold (src, hyparquet/ColumnarParser) or sample phys_footprint on macOS instead of RSS (isolation-node).",
);
