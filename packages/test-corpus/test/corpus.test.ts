import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  loadCorpus,
  loadManifest,
  sha256,
  validateManifest,
  verifyCorpus,
} from "../src/index.ts";

const manifest = loadManifest(
  readFileSync(new URL("../corpus.manifest.json", import.meta.url), "utf8"),
);

test("manifest entries are generated deterministically", () => {
  const first = loadCorpus(manifest, ".");
  const second = loadCorpus(manifest, ".");
  assert.deepEqual(
    first.map((item) => [item.id, item.mediaType, sha256(item.bytes)]),
    second.map((item) => [item.id, item.mediaType, sha256(item.bytes)]),
  );
  assert.ok(first.some((item) => item.mediaType === "text/plain"));
});

test("verification reports checksum mismatches", () => {
  assert.deepEqual(verifyCorpus(manifest, "."), []);
  const broken = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  (broken.entries[0] as { sha256: string }).sha256 = "0".repeat(64);
  const errors = verifyCorpus(broken, ".");
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /checksum mismatch/);
});

test("validation rejects duplicate ids and missing licenses", () => {
  assert.throws(() =>
    validateManifest({
      version: 1,
      entries: [
        { id: "a", mediaType: "text/plain", sha256: "0".repeat(64), license: "CC0", source: { kind: "generated", generator: "text-plain" } },
        { id: "a", mediaType: "text/plain", sha256: "0".repeat(64), license: "CC0", source: { kind: "generated", generator: "text-plain" } },
      ],
    }),
  );
  assert.throws(() =>
    validateManifest({
      version: 1,
      entries: [
        { id: "a", mediaType: "text/plain", sha256: "0".repeat(64), source: { kind: "generated", generator: "text-plain" } },
      ],
    }),
  );
});
