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
