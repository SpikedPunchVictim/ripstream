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
