import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { RipstreamInputStream } from "../src/ripstream-input-stream.ts";

const encoder = new TextEncoder();

async function collect(stream: RipstreamInputStream): Promise<string> {
  let result = "";
  for await (const chunk of stream) result += new TextDecoder().decode(chunk);
  return result;
}

test("peek does not consume", async () => {
  const stream = await RipstreamInputStream.from(encoder.encode("hello"));
  assert.equal(new TextDecoder().decode(await stream.peek(3)), "hel");
  assert.equal(new TextDecoder().decode(await stream.peek(5)), "hello");
  assert.equal(await collect(stream), "hello");
});

test("mark and reset rewind", async () => {
  const stream = await RipstreamInputStream.from(encoder.encode("abcdef"));
  stream.mark();
  assert.equal(new TextDecoder().decode(await stream.read()), "abcdef");
  await stream.reset();
  assert.equal(new TextDecoder().decode(await stream.read()), "abcdef");
});

test("spools to disk above the threshold", async () => {
  const stream = await RipstreamInputStream.from(encoder.encode("0123456789abcdef"), {
    spoolThreshold: 4,
  });
  assert.equal(await collect(stream), "0123456789abcdef");
  assert.equal(stream.hasFile, true);
  const path = await stream.getFile();
  assert.equal(existsSync(path), true);
  assert.equal(await readFile(path, "utf8"), "0123456789abcdef");
  await stream.close();
  assert.equal(existsSync(path), false);
});

test("getFile forces spooling for small inputs", async () => {
  const stream = await RipstreamInputStream.from(encoder.encode("small"));
  const path = await stream.getFile();
  assert.equal(await readFile(path, "utf8"), "small");
  assert.equal(stream.length, 5);
  await stream.close();
});

test("seek supports start, current, and end", async () => {
  const stream = await RipstreamInputStream.from(encoder.encode("abcdef"));
  await stream.seek(2);
  assert.equal(new TextDecoder().decode(await stream.read()), "cdef");
  await stream.seek(-2, "current");
  assert.equal(new TextDecoder().decode(await stream.read()), "ef");
  await stream.seek(-2, "end");
  assert.equal(new TextDecoder().decode(await stream.read()), "ef");
});

test("aborted input throws", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  const stream = await RipstreamInputStream.from(encoder.encode("abc"), {
    signal: controller.signal,
  });
  await assert.rejects(stream.read(), /stop/);
});

test("registers with ParseContext resources", async () => {
  const { ParseContext } = await import("../src/parse-context.ts");
  const context = new ParseContext();
  const stream = await RipstreamInputStream.from(encoder.encode("abc"), { context });
  assert.equal(context.resources.size, 1);
  await context.resources.closeAll();
  assert.equal(await stream.read(), null);
});

test("spooled files are owner-only and cleaned up", async () => {
  const { stat } = await import("node:fs/promises");
  const stream = await RipstreamInputStream.from(
    new Uint8Array(64 * 1024),
    { threshold: 1024 },
  );
  const path = await stream.getFile();
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode & 0o077, 0);
  assert.equal(mode & 0o400, 0o400);
  await stream.close();
  await assert.rejects(stat(path));
});

test("spills while draining instead of buffering the whole input", async () => {
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 100; i++) yield new Uint8Array(1024).fill(i);
  }
  const stream = await RipstreamInputStream.from(source(), { spoolThreshold: 4096 });
  await stream.seek(0, "end");
  assert.equal(stream.hasFile, true);
  const held = (stream as unknown as { chunks: Uint8Array[] }).chunks;
  assert.equal(held.length, 0);
  assert.equal(stream.length, 100 * 1024);
  await stream.seek(50 * 1024);
  assert.equal((await stream.peek(1))[0], 50);
  await stream.close();
});

// tikajs-0vn4: readAt used to scan the chunk list from the start on every read,
// so iterating many tiny chunks was quadratic. These tests count chunk visits
// (deterministic) instead of timing, and compare against a flat-buffer model.

type Held = { chunks: Uint8Array[] };

function countChunkVisits(stream: RipstreamInputStream): { visits: () => number } {
  const held = stream as unknown as Held;
  let visits = 0;
  held.chunks = new Proxy(held.chunks, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) visits++;
      return Reflect.get(target, property, receiver);
    },
  });
  return { visits: () => visits };
}

async function* tinyChunks(count: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < count; i++) yield new Uint8Array([i & 255]);
}

test("sequential reads of tiny chunks visit each chunk a bounded number of times", async () => {
  const count = 2000;
  const stream = await RipstreamInputStream.from(tinyChunks(count));
  const counter = countChunkVisits(stream);
  let total = 0;
  for await (const chunk of stream) {
    assert.equal(chunk[0], total & 255);
    total += chunk.length;
  }
  assert.equal(total, count);
  // The old scan visited count * (count + 1) / 2 = 2,001,000 chunks.
  assert.ok(counter.visits() <= 4 * count, `visited ${counter.visits()} chunks`);
  await stream.close();
});

test("sequential peek-then-read of tiny chunks stays linear", async () => {
  const count = 1000;
  const stream = await RipstreamInputStream.from(tinyChunks(count));
  const counter = countChunkVisits(stream);
  for (let i = 0; i < count; i++) {
    assert.equal((await stream.peek(1))[0], i & 255);
    assert.equal((await stream.read())![0], i & 255);
  }
  assert.equal(await stream.read(), null);
  assert.ok(counter.visits() <= 8 * count, `visited ${counter.visits()} chunks`);
  await stream.close();
});

test("reading before the cursor still returns the right bytes after a long forward scan", async () => {
  const stream = await RipstreamInputStream.from(tinyChunks(300));
  while ((await stream.read()) !== null);
  await stream.seek(10);
  assert.deepEqual([...(await stream.peek(3))], [10, 11, 12]);
  await stream.seek(299);
  assert.deepEqual([...(await stream.peek(5))], [299 & 255]);
  await stream.seek(0);
  assert.deepEqual([...(await stream.peek(2))], [0, 1]);
  await stream.close();
});

// Small deterministic PRNG so the sequence is the same on every run.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("random chunkings and read/seek/peek/mark/reset sequences match a flat-buffer model", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const random = prng(seed);
    const int = (max: number): number => Math.floor(random() * (max + 1));
    const total = int(600);
    const data = new Uint8Array(total).map(() => int(255));
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < total; ) {
      const size = random() < 0.3 ? 0 : 1 + int(random() < 0.5 ? 2 : 40);
      pieces.push(data.subarray(at, at + size));
      at += size;
    }
    // Some seeds spill part-way through the sequence (threshold below total).
    const spoolThreshold = seed % 4 === 0 ? int(total) : 1 << 20;
    const stream = await RipstreamInputStream.from(
      (async function* () {
        yield* pieces;
      })(),
      { spoolThreshold },
    );

    let cursor = 0;
    let marked = 0;
    for (let step = 0; step < 120; step++) {
      const op = int(6);
      const label = `seed ${seed} step ${step} op ${op}`;
      if (op <= 1) {
        const chunk = await stream.read();
        if (cursor >= total) {
          assert.equal(chunk, null, label);
        } else {
          assert.ok(chunk !== null && chunk.length > 0, label);
          assert.deepEqual(chunk, data.subarray(cursor, cursor + chunk.length), label);
          cursor += chunk.length;
        }
      } else if (op === 2) {
        const count = int(50);
        assert.deepEqual(
          await stream.peek(count),
          data.subarray(cursor, Math.min(total, cursor + count)),
          label,
        );
      } else if (op === 3) {
        const target = int(total);
        assert.equal(await stream.seek(target), target, label);
        cursor = target;
      } else if (op === 4) {
        stream.mark();
        marked = cursor;
      } else if (op === 5) {
        await stream.reset();
        cursor = Math.min(marked, total);
        assert.equal(stream.position, cursor, label);
      } else {
        const limit = int(total + 5);
        if (total - cursor > limit) {
          await assert.rejects(stream.readFully(limit), /exceeds/, label);
        } else {
          assert.deepEqual(await stream.readFully(limit), data.subarray(cursor), label);
          cursor = total;
        }
      }
      assert.equal(stream.position, cursor, label);
    }
    await stream.close();
  }
});
