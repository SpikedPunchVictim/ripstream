import assert from "node:assert/strict";
import { test } from "node:test";
import { RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { CompoundFile } from "../src/containers/cfb.ts";
import { detectBplist } from "../src/containers/bplist.ts";
import { detectOle2Container } from "../src/index.ts";
import { ole2 } from "./ole2-fixture.ts";

/*
 * OLE2 and binary-plist detection read a small input from memory, with no temp file made for it
 * (RipstreamInputStream.openReader), and a larger one from its file. The two must give the same answer, or the same
 * error, for every input, the damaged ones included.
 */

const encoder = new TextEncoder();
const MEMORY = 1024 * 1024;

interface Outcome {
  readonly result: string;
  readonly file: boolean;
}

async function run(
  detect: (stream: RipstreamInputStream) => Promise<{ toString(): string } | null>,
  bytes: Uint8Array,
  spoolThreshold: number,
): Promise<Outcome> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold });
  try {
    let result: string;
    try {
      result = String(await detect(stream));
    } catch (error) {
      result = `threw ${(error as Error).constructor.name}: ${(error as Error).message}`;
    }
    return { result, file: stream.hasFile };
  } finally {
    await stream.close();
  }
}

/** The answer from memory and from a file, which must agree; the file flags say where each was read. */
async function both(
  detect: (stream: RipstreamInputStream) => Promise<{ toString(): string } | null>,
  bytes: Uint8Array,
): Promise<{ memory: Outcome; file: Outcome }> {
  const memory = await run(detect, bytes, MEMORY);
  const file = await run(detect, bytes, 0);
  assert.equal(memory.result, file.result);
  return { memory, file };
}

const ole = (bytes: Uint8Array) => both((stream) => detectOle2Container(stream), bytes);
const plist = (bytes: Uint8Array) => both((stream) => detectBplist(stream), bytes);

const WORD = ole2([{ name: "WordDocument", data: encoder.encode("word") }]);
const DRAW = ole2([
  { name: "StarDrawDocument3" },
  { name: "\u0001CompObj", data: encoder.encode("....StarDraw....") },
]);
// A stream past the mini-stream cutoff lives in regular sectors, and CompObj is searched a chunk at a time.
const BIG_COMP_OBJ = ole2([
  { name: "StarDrawDocument3" },
  { name: "\u0001CompObj", data: new Uint8Array([...new Uint8Array(6000), ...encoder.encode("StarImpress")]) },
]);
const LARGE_SECTORS = ole2([{ name: "WordDocument", data: encoder.encode("word") }], 4096);

function patch(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

test("a small compound file is detected from memory and a spilled one from its file, to the same type", async () => {
  for (const [bytes, expected] of [
    [WORD, "application/msword"],
    [DRAW, "application/vnd.stardivision.draw"],
    [BIG_COMP_OBJ, "application/vnd.stardivision.impress"],
    [LARGE_SECTORS, "application/msword"],
  ] as const) {
    const { memory, file } = await ole(bytes);
    assert.deepEqual(memory, { result: expected, file: false });
    assert.deepEqual(file, { result: expected, file: true });
  }
});

test("a damaged compound file reads the same from memory as from a file, and never makes a file for itself", async () => {
  const variants: Uint8Array[] = [
    WORD.subarray(0, 100),
    WORD.subarray(0, 511),
    WORD.subarray(0, WORD.length - 10),
    WORD.subarray(0, WORD.length - 512),
    DRAW.subarray(0, DRAW.length - 700),
    new Uint8Array([...new Uint8Array(100), ...WORD]),
    WORD.subarray(16),
    new Uint8Array(),
  ];
  // Header fields: FAT count, directory start, mini FAT start and count, DIFAT start and count.
  for (const offset of [44, 48, 60, 64, 68, 72]) {
    for (const value of [0, 1, 7, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) variants.push(patch(DRAW, offset, value));
  }
  // The first FAT entries, and a directory entry's child, siblings and start sector: loops and sectors outside the file.
  for (const offset of [512 * 4, 512 * 4 + 4, 512 * 4 + 8, 512 + 68, 512 + 72, 512 + 76, 512 + 116, 512 + 128 + 116]) {
    for (const value of [0, 1, 2, 3, 0xfffffffe, 0xffffffff, 0x7fffffff]) variants.push(patch(DRAW, offset, value));
  }
  for (const bytes of variants) {
    const { memory } = await ole(bytes);
    assert.equal(memory.file, false, memory.result);
  }
});

test("CompoundFile.from closes the reader of a file that is not a compound file", async () => {
  const stream = await RipstreamInputStream.from(encoder.encode("not a compound file at all"));
  const reader = await stream.openReader();
  let closed = false;
  const close = reader.close.bind(reader);
  reader.close = async () => {
    closed = true;
    await close();
  };
  try {
    assert.equal(await CompoundFile.from(reader), null);
    assert.equal(closed, true);
  } finally {
    await stream.close();
  }
});

function bplist(root: Record<string, number>, trailer: Partial<{ top: bigint; count: bigint; table: bigint }> = {}): Uint8Array {
  // Object 0 is the root dictionary, then one string per key and one small int per value; every reference is one byte.
  const objects: number[][] = [];
  const keys = Object.keys(root);
  const header = [0xd0 | keys.length];
  for (let index = 0; index < keys.length; index++) header.push(1 + index);
  for (let index = 0; index < keys.length; index++) header.push(1 + keys.length + index);
  objects.push(header);
  // A length of 15 or more follows the marker as an int object.
  for (const key of keys) {
    const length = key.length < 15 ? [0x50 | key.length] : [0x5f, 0x10, key.length];
    objects.push([...length, ...encoder.encode(key)]);
  }
  for (const key of keys) objects.push([0x10, root[key]!]);
  const body: number[] = [...encoder.encode("bplist00")];
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body.push(...object);
  }
  const tableOffset = body.length;
  body.push(...offsets);
  const end = new Uint8Array(32);
  const view = new DataView(end.buffer);
  end[6] = 1;
  end[7] = 1;
  view.setBigUint64(8, trailer.count ?? BigInt(objects.length));
  view.setBigUint64(16, trailer.top ?? 0n);
  view.setBigUint64(24, trailer.table ?? BigInt(tableOffset));
  return new Uint8Array([...body, ...end]);
}

test("a small binary plist is detected from memory and a spilled one from its file, to the same type", async () => {
  for (const [bytes, expected] of [
    [bplist({ nodes: 1, edges: 2, graphEncodingVersion: 3 }), "application/x-bplist-memgraph"],
    [bplist({ WebMainResource: 1 }), "application/x-bplist-webarchive"],
    [bplist({ Playlists: 1, Tracks: 2, "Music Folder": 3 }), "application/x-bplist-itunes"],
    [bplist({ other: 1 }), "application/x-bplist"],
  ] as const) {
    const { memory, file } = await plist(bytes);
    assert.deepEqual(memory, { result: expected, file: false });
    assert.deepEqual(file, { result: expected, file: true });
  }
});

test("a damaged binary plist reads the same from memory as from a file, and never makes a file for itself", async () => {
  const good = bplist({ WebMainResource: 1 });
  const variants: Uint8Array[] = [
    good.subarray(0, 20),
    good.subarray(0, 39),
    good.subarray(0, good.length - 10),
    good.subarray(1),
    new Uint8Array(),
  ];
  // Trailer fields that lie: offsets and counts at, past and far past 2^53, and a root that is not an object.
  for (const value of [0n, 1n, 2n ** 31n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 60n, 2n ** 64n - 1n]) {
    variants.push(bplist({ WebMainResource: 1 }, { top: value }));
    variants.push(bplist({ WebMainResource: 1 }, { count: value }));
    variants.push(bplist({ WebMainResource: 1 }, { table: value }));
  }
  for (const bytes of variants) {
    const { memory } = await plist(bytes);
    assert.equal(memory.file, false, memory.result);
  }
});
