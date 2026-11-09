import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import {
  DEFAULT_CHILD_STDERR_BUDGET_BYTES,
  MAX_HEADER_BYTES,
  encodeInputPrefix,
  installStderrGuard,
  readInput,
  type InputHeader,
} from "../src/child-io.ts";

const header = (overrides: Partial<InputHeader> = {}): InputHeader => ({ v: 1, output: "text", byteLength: 0, ...overrides });
const stream = (...chunks: Uint8Array[]): Readable => Readable.from(chunks, { objectMode: false });
const wire = (h: InputHeader, body: Uint8Array = new Uint8Array(0)): Uint8Array => Buffer.concat([encodeInputPrefix(h), body]);

test("round trip: header fields and bytes survive", async () => {
  const body = Buffer.from("raw \u0000 bytes\n");
  const sent = header({ byteLength: body.length, filename: "f.bin", maxOutputChars: 5, maxEmbeddedResources: 2, output: "records" });
  const got = await readInput(stream(wire(sent, body)));
  assert.deepEqual(got.header, sent);
  assert.deepEqual(Buffer.from(got.bytes), body);
});

test("maxParseMillis round trips, including 0 (no in-child parse timer)", async () => {
  for (const maxParseMillis of [0, 1, 59_000]) {
    const got = await readInput(stream(wire(header({ maxParseMillis }))));
    assert.equal(got.header.maxParseMillis, maxParseMillis);
  }
  assert.equal((await readInput(stream(wire(header())))).header.maxParseMillis, undefined);
});

test("round trip across arbitrary chunk boundaries (1 byte at a time)", async () => {
  const body = Buffer.from("0123456789");
  const all = wire(header({ byteLength: body.length }), body);
  const chunks = Array.from(all, (b) => Uint8Array.of(b));
  const got = await readInput(stream(...chunks));
  assert.equal(Buffer.from(got.bytes).toString(), "0123456789");
});

test("{ path } input carries no bytes", async () => {
  const got = await readInput(stream(wire(header({ path: "/some/file" }))));
  assert.equal(got.header.path, "/some/file");
  assert.equal(got.bytes.length, 0);
});

test("truncated input rejects", async () => {
  await assert.rejects(readInput(stream(wire(header({ byteLength: 10 }), Buffer.from("abc")))), /truncated/);
});

test("trailing bytes after the announced length reject", async () => {
  await assert.rejects(readInput(stream(wire(header({ byteLength: 1 }), Buffer.from("abc")))), /trailing/);
});

test("an oversized header length rejects before allocating it", async () => {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(MAX_HEADER_BYTES + 1, 0);
  await assert.rejects(readInput(stream(prefix)), RangeError);
});

test("encodeInputPrefix refuses an oversized header", () => {
  assert.throws(() => encodeInputPrefix(header({ filename: "x".repeat(MAX_HEADER_BYTES) })), RangeError);
});

for (const [label, json] of [
  ["not JSON", "nope"],
  ["an array", "[]"],
  ["wrong version", '{"v":2,"output":"text","byteLength":0}'],
  ["unknown output", '{"v":1,"output":"xml","byteLength":0}'],
  ["negative byteLength", '{"v":1,"output":"text","byteLength":-1}'],
  ["path with bytes", '{"v":1,"output":"text","byteLength":3,"path":"/x"}'],
  ["empty path", '{"v":1,"output":"text","byteLength":0,"path":""}'],
  ["non-integer maxOutputChars", '{"v":1,"output":"text","byteLength":0,"maxOutputChars":1.5}'],
  ["non-integer maxParseMillis", '{"v":1,"output":"text","byteLength":0,"maxParseMillis":1.5}'],
  ["negative maxParseMillis", '{"v":1,"output":"text","byteLength":0,"maxParseMillis":-1}'],
  ["string maxParseMillis", '{"v":1,"output":"text","byteLength":0,"maxParseMillis":"50"}'],
  ["null maxParseMillis", '{"v":1,"output":"text","byteLength":0,"maxParseMillis":null}'],
] as const) {
  test(`malformed header rejects: ${label}`, async () => {
    const body = Buffer.from(json);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length, 0);
    await assert.rejects(readInput(stream(Buffer.concat([prefix, body]))), TypeError);
  });
}

// ---- initChildProcess / the child's own stderr budget (R2) ---------------------------------------------------

/** A stand-in for process.stderr that records what reaches it. */
function sink(): { stream: Writable; received: () => number; chunks: string[] } {
  const chunks: string[] = [];
  let bytes = 0;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, received: () => bytes, chunks };
}

test("the child's default stderr budget is 256 KiB, well below the parent's 1 MiB", () => {
  assert.equal(DEFAULT_CHILD_STDERR_BUDGET_BYTES, 256 * 1024);
});

test("stderr guard: writes pass through up to the budget, later ones are dropped and report success", () => {
  const { stream, received } = sink();
  const guard = installStderrGuard(stream, 100);
  assert.equal(stream.write("a".repeat(60)), true);
  assert.equal(stream.write("b".repeat(40)), true); // exactly at the budget
  assert.equal(guard.exhausted(), false);
  assert.equal(stream.write("c"), true); // dropped
  assert.equal(guard.exhausted(), true);
  assert.equal(received(), 100);
  assert.equal(guard.writtenBytes(), 100);
});

test("stderr guard: a write that would cross the budget is dropped whole, and so is everything after it", () => {
  const { stream, received } = sink();
  const guard = installStderrGuard(stream, 100);
  stream.write("a".repeat(90));
  stream.write("b".repeat(20)); // would reach 110
  stream.write("c"); // would fit, but the budget is spent
  assert.equal(received(), 90);
  assert.equal(guard.exhausted(), true);
});

test("stderr guard: dropped writes still call their callback (both write() signatures)", async () => {
  const { stream } = sink();
  installStderrGuard(stream, 1);
  stream.write("xx");
  const calls: string[] = [];
  stream.write("y", () => calls.push("cb2"));
  stream.write("z", "utf8", () => calls.push("cb3"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["cb2", "cb3"]);
});

test("stderr guard: the budget counts BYTES, not characters", () => {
  const { stream, received } = sink();
  installStderrGuard(stream, 10);
  stream.write("\u00e9".repeat(5)); // 10 bytes in 5 characters
  stream.write("x"); // dropped
  assert.equal(received(), 10);
});

test("stderr guard: Buffers and Uint8Arrays count by length", () => {
  const { stream, received } = sink();
  installStderrGuard(stream, 6);
  stream.write(Buffer.from("abcd"));
  stream.write(new Uint8Array([1, 2]));
  stream.write(Buffer.from("e"));
  assert.equal(received(), 6);
});

test("stderr guard: console.error goes through the guarded write", () => {
  const { stream, received } = sink();
  installStderrGuard(stream, 5);
  const console2 = new console.Console({ stdout: new PassThrough(), stderr: stream });
  console2.error("0123456789"); // 11 bytes with the newline: over the budget
  assert.equal(received(), 0);
});

test("stderr guard: EPIPE, ENOTCONN and ERR_STREAM_DESTROYED are ignored, and end the writing", () => {
  for (const code of ["EPIPE", "ENOTCONN", "ERR_STREAM_DESTROYED"]) {
    const { stream } = sink();
    const guard = installStderrGuard(stream, 1000);
    assert.doesNotThrow(() => stream.emit("error", Object.assign(new Error(code), { code })), code);
    assert.equal(guard.exhausted(), true, `${code} means the pipe is gone: stop writing`);
  }
});

test("stderr guard: any other stream error is not swallowed", () => {
  const { stream } = sink();
  installStderrGuard(stream, 1000);
  assert.throws(() => stream.emit("error", Object.assign(new Error("disk on fire"), { code: "EIO" })), /disk on fire/);
});

test("stderr guard: a second install on the same stream is the same guard (no double wrapping)", () => {
  const { stream, received } = sink();
  const first = installStderrGuard(stream, 10);
  const second = installStderrGuard(stream, 99_999);
  assert.equal(second, first);
  stream.write("a".repeat(10));
  stream.write("b");
  assert.equal(received(), 10, "counted once, against the first budget");
  assert.equal(stream.listenerCount("error"), 1);
});

test("stderr guard: rejects a budget that is not a non-negative safe integer", () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    assert.throws(() => installStderrGuard(sink().stream, bad), RangeError, String(bad));
  }
  assert.doesNotThrow(() => installStderrGuard(sink().stream, 0));
});

test("stderr guard: counts BYTES of any typed array or DataView, not elements, and never goes NaN", () => {
  const { stream, received } = sink();
  const guard = installStderrGuard(stream, 100);
  stream.write(new Uint16Array(10)); // 20 bytes
  assert.equal(guard.writtenBytes(), 20);
  stream.write(new DataView(new ArrayBuffer(30))); // 30 bytes; used to turn the counter into NaN and disable the budget
  assert.equal(guard.writtenBytes(), 50);
  stream.write(Buffer.alloc(60)); // 110 > 100: dropped
  assert.equal(guard.exhausted(), true);
  assert.equal(received(), 50);
});
