import assert from "node:assert/strict";
import { test } from "node:test";
import { RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { detectOle2Container } from "../src/index.ts";
import { ole2, ole2FromSpec, type Ole2Entry, type Ole2Spec, type SpecEntry } from "./ole2-fixture.ts";

// Detection runs on untrusted bytes in the caller's process before any parser limit applies. Whatever the header and
// directory claim, it must stop, stay within its read and size bounds, and answer (null, or plain OLE) rather than throw.

const encoder = new TextEncoder();
const END_OF_CHAIN = 0xfffffffe;
const PLAIN_OLE = "application/x-tika-msoffice";

async function detect(bytes: Uint8Array): Promise<string | null> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    return (await detectOle2Container(stream))?.toString() ?? null;
  } finally {
    await stream.close();
  }
}

function patched(spec: Ole2Spec, ...patches: { offset: number; value: number; width?: 1 | 2 | 4 }[]): Uint8Array {
  return ole2FromSpec({ ...spec, patches: patches.map((patch) => ({ ...patch, width: patch.width ?? 4 })) });
}

const plain: Ole2Spec = { entries: [{ name: "a" }, { name: "WordDocument" }] };
const draw: Ole2Spec = {
  entries: [{ name: "StarDrawDocument3" }, { name: "\u0001CompObj", text: "StarDraw", textAt: 8 }],
};
// plain: sector 0 is the directory and sector 1 the FAT. draw: 0 directory, 1 mini FAT, 2 mini stream, 3 FAT.
const FAT_ENTRY_0 = 512 * 2;
const FAT_ENTRY_1 = 512 * 2 + 4;
const entryField = (index: number, field: number): number => 512 + index * 128 + field;

test("a valid file reads as itself", async () => {
  assert.equal(await detect(ole2FromSpec(plain)), "application/msword");
  assert.equal(await detect(ole2FromSpec(draw)), "application/vnd.stardivision.draw");
});

test("a directory chain that loops back on itself is unreadable", async () => {
  const bytes = patched({ entries: ["a", "WordDocument", "c", "d", "e"].map((name) => ({ name })) }, { offset: 512 * 3 + 4, value: 0 });
  assert.equal(await detect(bytes), null);
});

test("a directory chain that never ends is unreadable, not walked forever", async () => {
  assert.equal(await detect(patched(plain, { offset: FAT_ENTRY_0, value: 0 })), null);
});

// Without the loop guard the chain would repeat its one sector and its marker would still be found: the answer would
// be StarDraw instead of plain OLE.
test("a CompObj mini chain that loops is a fault, not repeated data", async () => {
  const spec: Ole2Spec = {
    entries: [{ name: "StarDrawDocument3" }, { name: "\u0001CompObj", text: "StarDraw", textAt: 8, length: 100 }],
  };
  assert.equal(await detect(ole2FromSpec(spec)), "application/vnd.stardivision.draw");
  assert.equal(await detect(patched(spec, { offset: 512 * 2, value: 0 })), PLAIN_OLE);
});

test("a FAT array that names one sector twice is unreadable", async () => {
  assert.equal(await detect(patched(plain, { offset: 44, value: 2 }, { offset: 80, value: 1 })), null);
});

test("a DIFAT chain that names itself is unreadable", async () => {
  const bytes = ole2FromSpec({ entries: [{ name: "Filler", length: 7_300_000 }, { name: "WordDocument" }] });
  assert.equal(await detect(bytes), "application/msword");
  const difatStart = new DataView(bytes.buffer).getUint32(68, true);
  const view = new DataView(bytes.buffer);
  view.setUint32(72, 2, true);
  view.setUint32(512 * (difatStart + 1) + 508, difatStart, true);
  assert.equal(await detect(bytes), null);
});

test("counts far beyond the file are unreadable and nothing is allocated from them", async () => {
  for (const count of [0x7fffffff, 0xffffffff, 0x10000, 1_000_000]) {
    assert.equal(await detect(patched(plain, { offset: 44, value: count })), null, `FAT count ${count}`);
  }
  for (const count of [0x7fffffff, 100_000]) {
    assert.equal(await detect(patched(plain, { offset: 72, value: count })), null, `DIFAT count ${count}`);
  }
  // A mini FAT count past the chain just stops at the chain's end; a start outside the file is a fault.
  assert.equal(await detect(patched(draw, { offset: 64, value: 0x7fffffff })), "application/vnd.stardivision.draw");
  assert.equal(await detect(patched(draw, { offset: 60, value: 5000 }, { offset: 64, value: 0x7fffffff })), null);
});

test("a stream claiming gigabytes is read from its chain, not its size", async () => {
  const entry = 512 + 2 * 128;
  for (const size of [0x7fffffff, 0xffffffff, 0x80000000]) {
    assert.equal(await detect(patched(draw, { offset: entry + 120, value: size })), PLAIN_OLE, `size ${size}`);
  }
});

test("directory entry indexes that point anywhere are unreadable or ignored, never followed past the directory", async () => {
  for (const value of [0x7fffffff, 0x80000000, 0xffffffff - 1, 100_000]) {
    assert.equal(await detect(patched(plain, { offset: entryField(0, 76), value })), null, `root child ${value}`);
    // The last entry has no real sibling, so an out-of-range one is ignored and WordDocument is still reached.
    assert.equal(await detect(patched(plain, { offset: entryField(2, 72), value })), "application/msword", `sibling ${value}`);
    // The first entry's sibling is the way to WordDocument: ignored indexes cut it off, they are not followed.
    assert.equal(await detect(patched(plain, { offset: entryField(1, 72), value })), PLAIN_OLE, `cut sibling ${value}`);
  }
});

// A storage or the root named as its own child (or a sibling loop) revisits entries for ever without the visited set.
test("a directory tree that loops back on itself is unreadable", async () => {
  const storage: Ole2Spec = { entries: [{ name: "s", children: [{ name: "x" }] }, { name: "WordDocument" }] };
  assert.equal(await detect(ole2FromSpec(storage)), "application/msword");
  assert.equal(await detect(patched(storage, { offset: entryField(1, 76), value: 1 })), null, "storage is its own child");
  assert.equal(await detect(patched(storage, { offset: entryField(0, 76), value: 0 })), null, "root is its own child");
  assert.equal(await detect(patched(storage, { offset: entryField(2, 72), value: 1 })), null, "sibling loop");
});

test("a name length that reaches past its entry is unreadable, not read out of range", async () => {
  // Entry "a" is not needed to reach WordDocument. 130 bytes is 64 units, the most an entry holds; a negative length is an empty name.
  for (const length of [130, 0xfffe]) {
    const answer = await detect(patched(plain, { offset: entryField(1, 64), value: length, width: 2 }));
    assert.equal(answer, "application/msword", `name length ${length}`);
  }
  for (const length of [132, 0x7ffe, 0x7fff]) {
    assert.equal(await detect(patched(plain, { offset: entryField(1, 64), value: length, width: 2 })), null, `name length ${length}`);
  }
});

test("a sector size other than 512 or 4096 is unreadable and nothing is sized from it", async () => {
  for (const shift of [0, 8, 10, 13, 16, 31, 32, 0xffff]) {
    assert.equal(await detect(patched(plain, { offset: 30, value: shift, width: 2 })), null, `sector shift ${shift}`);
  }
  // A well-formed file laid out in 1024 or 2048-byte sectors would read fine if the size came from the header; POI
  // refuses it (measured: StarCalcDocument in such a file is plain OLE at Tika).
  for (const [size, shift] of [[1024, 10], [2048, 11]] as const) {
    const bytes = ole2([{ name: "StarCalcDocument" }], size as unknown as 512);
    new DataView(bytes.buffer).setUint16(30, shift, true);
    assert.equal(await detect(bytes), null, `${size}-byte sectors`);
  }
});

test("a start sector outside the file is unreadable, or an unreadable stream", async () => {
  for (const sector of [100_000, 0x7fffffff, 0xfffffffd]) {
    assert.equal(await detect(patched(plain, { offset: 48, value: sector })), null, `directory at ${sector}`);
    assert.equal(await detect(patched(plain, { offset: 76, value: sector })), null, `FAT at ${sector}`);
    assert.equal(await detect(patched(draw, { offset: entryField(2, 116), value: sector })), PLAIN_OLE, `stream at ${sector}`);
  }
});

// The CompObj stream as a regular stream: directory 0, CompObj 1-8 (4096 bytes), FAT 9.
const bigCompObj: Ole2Spec = {
  entries: [{ name: "StarDrawDocument3" }, { name: "\u0001CompObj", text: "StarDraw", textAt: 8, length: 4096 }],
};
const BIG_FAT = 512 * (1 + 9);
const END_OF_FILE_PADDING = 200;

function padded(bytes: Uint8Array, sectors: number): Uint8Array {
  const result = new Uint8Array(bytes.length + sectors * 512);
  result.set(bytes);
  return result;
}

test("a chain that leaves the file or the FAT is unreadable, not read as zeros", async () => {
  assert.equal(await detect(ole2FromSpec(bigCompObj)), "application/vnd.stardivision.draw");
  // Sector 100 is past the end of the 11-sector file but inside the FAT's 128 entries.
  const leavesFile = patched(bigCompObj, { offset: BIG_FAT + 7 * 4, value: 100 }, { offset: BIG_FAT + 100 * 4, value: END_OF_CHAIN });
  assert.equal(await detect(leavesFile), PLAIN_OLE);
  // Sector 150 is inside a file padded to 211 sectors but past the FAT's 128 entries.
  const leavesFat = padded(patched(bigCompObj, { offset: BIG_FAT + 7 * 4, value: 150 }), END_OF_FILE_PADDING);
  assert.equal(await detect(leavesFat), PLAIN_OLE);
});

test("a stream that claims more bytes than its chain holds is unreadable, not read short", async () => {
  const mini: Ole2Spec = {
    entries: [{ name: "StarDrawDocument3" }, { name: "\u0001CompObj", text: "StarDraw", textAt: 8, length: 100 }],
  };
  assert.equal(await detect(patched(mini, { offset: entryField(2, 120), value: 1000 })), PLAIN_OLE);
  const big: Ole2Spec = {
    entries: [{ name: "StarDrawDocument3" }, { name: "\u0001CompObj", text: "StarDraw", textAt: 8, length: 5000 }],
  };
  assert.equal(await detect(ole2FromSpec(big)), "application/vnd.stardivision.draw");
  assert.equal(await detect(patched(big, { offset: entryField(2, 120), value: 100_000 })), PLAIN_OLE);
});

test("a FAT sector, or a mini FAT chain, outside the file or the FAT is unreadable", async () => {
  // A second FAT sector named at 100, past the end of the file.
  assert.equal(await detect(patched(plain, { offset: 44, value: 2 }, { offset: 80, value: 100 })), null);
  // A two-sector mini FAT at 150, in a padded file but past the FAT's 128 entries.
  const leavesFat = padded(patched(plain, { offset: 60, value: 150 }, { offset: 64, value: 2 }), END_OF_FILE_PADDING);
  assert.equal(await detect(leavesFat), null);
});

// Each DIFAT sector must be a distinct sector in the file, so a file can only name as many as it has; the bound
// stops a file of hundreds of thousands from being walked, while a real FAT never needs more than 130 (1 GiB mapped).
test("a DIFAT chain longer than any FAT needs is unreadable", async () => {
  const withDifatChain = (length: number): Uint8Array => {
    const base = ole2FromSpec(plain);
    const first = base.length / 512 - 1;
    const bytes = new Uint8Array(base.length + length * 512);
    bytes.set(base);
    const view = new DataView(bytes.buffer);
    view.setUint32(68, first, true);
    view.setUint32(72, length, true);
    for (let index = 0; index < length; index++) {
      const offset = 512 * (1 + first + index);
      view.setUint32(offset, 0xffffffff, true);
      view.setUint32(offset + 508, index + 1 < length ? first + index + 1 : END_OF_CHAIN, true);
    }
    return bytes;
  };
  assert.equal(await detect(withDifatChain(100)), "application/msword");
  assert.equal(await detect(withDifatChain(200)), null);
});

// Tika reads the whole CompObj stream (a name 20 MiB in still counts, measured). It is searched a chunk at a time, so
// a stream of any size costs time, not memory, and a name that straddles two chunks is still found.
test("the CompObj stream is searched whole, across chunk boundaries", async () => {
  const entries = (textAt: number, length: number): SpecEntry[] => [
    { name: "StarDrawDocument3" },
    { name: "\u0001CompObj", text: "StarDraw", textAt, length },
  ];
  assert.equal(await detect(ole2FromSpec({ entries: entries(1_300_000, 1_500_000) })), "application/vnd.stardivision.draw");
  // 128 sectors of 512 bytes are searched at a time: 65,536 bytes.
  for (const textAt of [65_528, 65_529, 65_532, 65_535, 65_536, 65_537]) {
    assert.equal(await detect(ole2FromSpec({ entries: entries(textAt, 200_000) })), "application/vnd.stardivision.draw", `at ${textAt}`);
  }
  // The name is not there once the stream stops short of it.
  assert.equal(await detect(ole2FromSpec({ entries: entries(0, 200_000).map((e) => (e.text === undefined ? e : { ...e, text: "Star", textAt: 65_532 })) })), PLAIN_OLE);
});

// POI builds a storage's children each time it is reached, so a stream, or a storage with none, can sit in two storages
// while a storage with children reached twice fails on the duplicate name (measured; the goldens hold the oracle's answer).
// Each re-visit rebuilds the entry's siblings, so a crafted directory could make that quadratic: it is budgeted.
test("entries shared between storages are accepted as POI does, within a budget", async () => {
  const shared = (storages: number): Uint8Array => {
    const entries: SpecEntry[] = [...Array.from({ length: storages }, (_, index) => ({ name: `s${index}`, children: [] })), { name: "x" }];
    const bytes = ole2FromSpec({ entries });
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const directory = (view.getUint32(48, true) + 1) * 512;
    for (let index = 1; index <= storages; index++) view.setUint32(directory + index * 128 + 76, storages + 1, true);
    return bytes;
  };
  assert.equal(await detect(shared(4000)), PLAIN_OLE);
  assert.equal(await detect(shared(5000)), null);
});

// Real directories have a few hundred entries. 8 MiB of directory (65,536 entries) is the bound; a file with more
// reads as unreadable instead of being parsed into millions of entries.
test("a directory over the size bound is unreadable and one just under it is read", async () => {
  const entriesFor = (count: number): Ole2Entry[] => {
    const entries: Ole2Entry[] = [{ name: "WordDocument" }];
    for (let index = 1; index < count; index++) entries.push({ name: `e${index}` });
    return entries;
  };
  assert.equal(await detect(ole2(entriesFor(65_000))), "application/msword");
  assert.equal(await detect(ole2(entriesFor(66_000))), null);
});

test("a truncated file falls back instead of reading short", async () => {
  const bytes = ole2FromSpec(draw);
  for (const length of [0, 7, 8, 100, 511, 512, 513, 1023, 1024, 1025, 1535, 1536, 1537, 2047, 2048]) {
    const answer = await detect(bytes.subarray(0, length));
    assert.ok(answer === null || answer === PLAIN_OLE, `truncated to ${length}: ${answer}`);
  }
  assert.equal(await detect(bytes.subarray(0, 512)), null);
});

test("a header with only the signature is unreadable", async () => {
  const bytes = new Uint8Array(4096);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(await detect(bytes), null);
  assert.equal(await detect(encoder.encode("not a compound file at all")), null);
});

// Corrupt a valid file at random and check that detection always answers. The generator is a fixed xorshift so a
// failure reproduces.
test("random corruption of valid files never throws", async () => {
  let state = 0x2545f491;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const seeds = [
    ole2FromSpec(plain),
    ole2FromSpec(draw),
    ole2FromSpec({ entries: [{ name: "x", children: [{ name: "y", children: [{ name: "Workbook" }] }] }, { name: "\u0001CompObj", text: "MSGraph.Chart.8" }] }),
    ole2FromSpec({ entries: [{ name: "StarDrawDocument3" }, { name: "\u0001CompObj", text: "StarImpress", textAt: 5000, length: 6000 }], sectorSize: 4096 }),
  ];
  for (let round = 0; round < 600; round++) {
    const bytes = new Uint8Array(seeds[round % seeds.length]!);
    for (let edit = 0, edits = 1 + (next() % 6); edit < edits; edit++) {
      // Aim most edits at the structures: the header, the first sectors.
      const limit = next() % 4 === 0 ? bytes.length : Math.min(bytes.length, 4096);
      bytes[next() % limit] = next() % 3 === 0 ? 0xff : next() & 0xff;
    }
    const cut = next() % 8 === 0 ? next() % bytes.length : bytes.length;
    await assert.doesNotReject(detect(bytes.subarray(0, cut)), `round ${round}`);
  }
});

test("detection finishes within a second on every hostile shape", async () => {
  const started = performance.now();
  await detect(patched(plain, { offset: FAT_ENTRY_0, value: 0 }));
  await detect(patched(plain, { offset: FAT_ENTRY_1, value: 1 }));
  await detect(patched(plain, { offset: 44, value: 0x7fffffff }));
  await detect(patched(draw, { offset: 512 * 2, value: 0 }));
  assert.ok(performance.now() - started < 1000);
});
