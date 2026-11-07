import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { loadCorpus, loadManifest } from "@spikedpunch/ripstream-test-corpus";
import { DefaultDetector } from "../src/index.ts";

interface Goldens {
  readonly tikaVersion: string;
  readonly entries: readonly { id: string; mediaType: string }[];
}

const manifest = loadManifest(
  readFileSync(
    new URL("../../../packages/test-corpus/corpus.manifest.json", import.meta.url),
    "utf8",
  ),
);
const goldens = JSON.parse(
  readFileSync(new URL("./detection-goldens.json", import.meta.url), "utf8"),
) as Goldens;

test("detection matches Tika 4.2 goldens", async () => {
  assert.equal(goldens.tikaVersion, "4.2.0");
  const items = new Map(
    loadCorpus(manifest, ".").map((item) => [item.id, item]),
  );
  const detector = new DefaultDetector();
  const failures: string[] = [];

  for (const golden of goldens.entries) {
    const item = items.get(golden.id);
    assert.ok(item !== undefined, `missing fixture ${golden.id}`);
    const stream = await RipstreamInputStream.from(item.bytes);
    try {
      const detected = await detector.detect(
        stream,
        new Metadata(),
        new ParseContext(),
      );
      const actual = `${detected.type}/${detected.subtype}`;
      if (actual !== golden.mediaType) {
        failures.push(`${golden.id}: expected ${golden.mediaType}, got ${actual}`);
      }
    } finally {
      await stream.close();
    }
  }
  assert.deepEqual(failures, []);
});
