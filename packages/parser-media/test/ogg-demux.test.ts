import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError } from "@spikedpunch/ripstream-core";
import { readOgg, type OggPacket } from "../src/ogg-demux.ts";
import { chunked, concat, enc, oggPage } from "./ogg-builder.ts";

/*
 * The Ogg demux: pages to packets, by the lacing values (RFC 3533). Every file here is built in the test.
 */

interface Seen {
  readonly packets: OggPacket[];
  readonly granules: [number, bigint][];
}

async function demux(bytes: Uint8Array, keepPackets = 3, chunkSize = 64 * 1024, limits = {}): Promise<Seen> {
  const seen: Seen = { packets: [], granules: [] };
  await readOgg(chunked(bytes, chunkSize), {
    keepPackets,
    onPacket: (packet) => seen.packets.push(packet),
    onGranule: (sid, granule) => seen.granules.push([sid, granule]),
    ...limits,
  });
  return seen;
}

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

test("packets are cut by the lacing values, and a packet that fills a segment goes on in the next page", async () => {
  const long = new Uint8Array(600).fill(7); // 255 + 255 + 90
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [bytes(1, 2, 3)], granule: 0n }),
    oggPage({ sid: 1, packets: [bytes(4), long.subarray(0, 510)], open: true }),
    oggPage({ sid: 1, continued: true, packets: [long.subarray(510), bytes(5, 6)], granule: 99n }),
  );
  const seen = await demux(file, 10);
  assert.deepEqual(seen.packets.map((p) => [p.index, p.beginningOfStream, [...p.data].slice(0, 3)]), [
    [0, true, [1, 2, 3]],
    [1, false, [4]],
    [2, false, [7, 7, 7]],
    [3, false, [5, 6]],
  ]);
  assert.equal(seen.packets[2]!.data.length, 600);
});

test("the same file read one byte at a time gives the same packets", async () => {
  const file = concat(
    oggPage({ sid: 9, bos: true, packets: [bytes(1, 2, 3)], granule: 0n }),
    oggPage({ sid: 9, packets: [new Uint8Array(700)], granule: 5n }),
  );
  const whole = await demux(file);
  const bytewise = await demux(file, 3, 1);
  assert.deepEqual(bytewise.packets, whole.packets);
  assert.deepEqual(bytewise.granules, whole.granules);
});

test("pages of two streams in turn are kept apart, and a packet past keepPackets is not delivered", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [bytes(10)], granule: 0n }),
    oggPage({ sid: 2, bos: true, packets: [bytes(20)], granule: 0n }),
    oggPage({ sid: 1, packets: [bytes(11), bytes(12)], granule: 7n }),
    oggPage({ sid: 2, packets: [bytes(21)], granule: 8n, eos: true }),
  );
  const seen = await demux(file, 2);
  const of = (sid: number): number[] => seen.packets.filter((p) => p.sid === sid).map((p) => p.data[0]!);
  assert.deepEqual(of(1), [10, 11]);
  assert.deepEqual(of(2), [20, 21]);
  assert.deepEqual(seen.granules, [[1, 0n], [2, 0n], [1, 7n], [2, 8n]]);
});

test("a granule of -1 and a page that completes no packet report no granule", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [bytes(1)], granule: 0n }),
    oggPage({ sid: 1, packets: [new Uint8Array(255)], open: true }),
    oggPage({ sid: 1, continued: true, packets: [bytes(2)] }),
  );
  const seen = await demux(file);
  assert.deepEqual(seen.granules, [[1, 0n]]);
});

test("bytes between pages are skipped to the next capture pattern, even one cut by a chunk boundary", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [bytes(1)], granule: 0n }),
    enc("junk Ogg junk Og"),
    oggPage({ sid: 1, packets: [bytes(2)], granule: 3n }),
  );
  for (const size of [1, 3, 5, 64]) {
    const seen = await demux(file, 3, size);
    assert.deepEqual(seen.packets.map((p) => p.data[0]), [1, 2], `chunk size ${size}`);
  }
});

test("a granule is a signed 64 bit value, kept whole", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [bytes(1)], granule: 0n }),
    oggPage({ sid: 1, packets: [bytes(2)], granule: 2n ** 62n + 5n }),
  );
  assert.deepEqual((await demux(file)).granules.at(-1), [1, 2n ** 62n + 5n]);
});

test("every prefix of a file reads without error, and delivers a prefix of the packets", async () => {
  const file = concat(
    oggPage({ sid: 1, bos: true, packets: [bytes(1, 2, 3)], granule: 0n }),
    oggPage({ sid: 1, packets: [bytes(4), new Uint8Array(255).fill(9)], open: true }),
    oggPage({ sid: 1, continued: true, packets: [new Uint8Array(45).fill(9)], granule: 4n, eos: true }),
  );
  const full = (await demux(file)).packets;
  for (let length = 0; length <= file.length; length++) {
    const seen = await demux(file.subarray(0, length));
    assert.deepEqual(seen.packets, full.slice(0, seen.packets.length), `prefix ${length}`);
  }
});

test("a packet that never ends is refused once the bytes it holds pass the cap", async () => {
  // Each page adds 255 bytes to the packet and says that it goes on.
  const first = oggPage({ sid: 1, bos: true, packets: [new Uint8Array(255)], open: true });
  const more = oggPage({ sid: 1, continued: true, packets: [new Uint8Array(255)], open: true });
  const pages = concat(first, ...Array.from({ length: 50 }, () => more));
  await assert.rejects(demux(pages, 3, 64 * 1024, { maxHeldBytes: 1000 }), LimitExceededError);
});

test("streams that begin and never end are refused past the cap, and ended ones are not counted", async () => {
  const begun = (sid: number): Uint8Array => oggPage({ sid, bos: true, packets: [bytes(1)], granule: 0n });
  const open = concat(...Array.from({ length: 6 }, (_, sid) => begun(sid)));
  await assert.rejects(demux(open, 3, 64 * 1024, { maxStreams: 5 }), LimitExceededError);

  // Twenty streams in a row, each ended: never more than one is open.
  const chained = concat(
    ...Array.from({ length: 20 }, (_, sid) => concat(begun(sid), oggPage({ sid, eos: true, packets: [bytes(2)], granule: 1n }))),
  );
  assert.equal((await demux(chained, 3, 64 * 1024, { maxStreams: 5 })).packets.length, 40);
});

test("many tiny pages are read in bounded steps: a stream that stops ending fails the test, not the run", async () => {
  // 27 byte pages with no segments. The fake stream throws after 100 chunks, so a loop that stopped ending would fail.
  const page = oggPage({ sid: 1, bos: true, packets: [], granule: 0n });
  const file = concat(...Array.from({ length: 2000 }, () => page));
  const seen: number[] = [];
  await readOgg(chunked(file, 1000, 100), { keepPackets: 1, onPacket: (p) => seen.push(p.index), maxStreams: 5 });
  assert.deepEqual(seen, []);
});
