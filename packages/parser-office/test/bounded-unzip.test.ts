import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError, ParseContext } from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { boundedUnzip } from "../src/bounded-unzip.ts";

const defaults = new ParseContext().limits;

test("indexes names without inflating, and gets one entry on demand", () => {
  const zip = boundedUnzip(
    zipSync({ "a.txt": strToU8("alpha"), "dir/b.txt": strToU8("beta") }),
    defaults,
  );
  assert.deepEqual([...zip.names], ["a.txt", "dir/b.txt"]);
  assert.equal(zip.has("a.txt"), true);
  assert.equal(zip.get("missing"), undefined);
  assert.equal(new TextDecoder().decode(zip.get("dir/b.txt")!), "beta");
});

test("an oversized entry is not inflated unless requested", () => {
  const zip = boundedUnzip(
    zipSync({ "big.bin": new Uint8Array(5_000_000), "ok.txt": strToU8("ok") }),
    defaults,
  );
  assert.equal(new TextDecoder().decode(zip.get("ok.txt")!), "ok");
  assert.throws(() => zip.get("big.bin"), LimitExceededError);
});

test("the package-wide total is shared across get() calls", () => {
  const entry = new Uint8Array(1000).map((_, i) => i * 7);
  const zip = boundedUnzip(zipSync({ "a.bin": entry, "b.bin": entry }, { level: 0 }), {
    ...defaults,
    maxTotalEmbeddedBytes: 1500,
  });
  assert.equal(zip.get("a.bin")!.byteLength, 1000);
  assert.throws(() => zip.get("b.bin"), LimitExceededError);
});

test("enforces maxZipEntries while indexing", () => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < 5; i++) files[`f${i}`] = strToU8("x");
  assert.throws(
    () => boundedUnzip(zipSync(files), { ...defaults, maxZipEntries: 3 }),
    LimitExceededError,
  );
});

// tikajs-w7n3: a lying deflate stream must be stopped by zlib's output cap, not after a whole expansion.
test("a deflate bomb is refused by the central-directory path with a bounded allocation", () => {
  const bomb = zipSync({ "bomb.bin": new Uint8Array(50_000_000) });
  const zip = boundedUnzip(bomb, { ...defaults, maxDecompressionRatio: 1_000_000, maxEmbeddedResourceBytes: 1_000_000 });
  assert.throws(() => zip.get("bomb.bin"), LimitExceededError);
});

test("thousands of entries index and read without exhausting the stack", () => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < 9000; i++) files[`f${i}`] = strToU8("x");
  const zip = boundedUnzip(zipSync(files), defaults);
  assert.equal(zip.names.length, 9000);
  assert.equal(new TextDecoder().decode(zip.get("f8999")!), "x");
});

test("a truncated archive with no central directory is still indexed by its local headers", () => {
  const whole = zipSync({ "a.txt": strToU8("alpha"), "b.txt": strToU8("beta") }, { level: 0 });
  const cut = whole.subarray(0, whole.byteLength - 60);
  const zip = boundedUnzip(cut, defaults);
  assert.ok(zip.has("a.txt"));
  assert.equal(new TextDecoder().decode(zip.get("a.txt")!), "alpha");
});

test("the local-header walk also stops a bomb before expanding it fully", () => {
  const bomb = zipSync({ "bomb.bin": new Uint8Array(50_000_000) });
  const directoryOffset = new DataView(bomb.buffer, bomb.byteOffset).getUint32(bomb.byteLength - 22 + 16, true);
  const cut = bomb.subarray(0, directoryOffset); // local entries only: no usable central directory
  const zip = boundedUnzip(cut, { ...defaults, maxDecompressionRatio: 1_000_000, maxEmbeddedResourceBytes: 1_000_000 });
  assert.throws(() => zip.get("bomb.bin"), LimitExceededError);
});
