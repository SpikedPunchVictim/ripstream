import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector, MagicDetector } from "../src/index.ts";

interface Golden {
  readonly id: string;
  readonly filename: string;
  /** The first `truncatedTo` bytes of a Tika 4.2.0 test document. */
  readonly bytes: string;
  /** Tika 4.2.0's answer for exactly these bytes and this name. */
  readonly tika: string;
}

const goldens = JSON.parse(readFileSync(new URL("./magic-goldens.json", import.meta.url), "utf8")) as {
  tikaVersion: string;
  cases: readonly Golden[];
};

const detector = new DefaultDetector();

test("magic and name detection matches Tika 4.2.0 on every measured document head", async () => {
  assert.equal(goldens.tikaVersion, "4.2.0");
  const failures: string[] = [];
  for (const golden of goldens.cases) {
    const stream = await RipstreamInputStream.from(new Uint8Array(Buffer.from(golden.bytes, "base64")));
    try {
      const metadata = new Metadata();
      metadata.set("tk:resource-name", golden.filename);
      const actual = (await detector.detect(stream, metadata, new ParseContext())).toString();
      if (actual !== golden.tika) failures.push(`${golden.id}: expected ${golden.tika}, got ${actual}`);
    } finally {
      await stream.close();
    }
  }
  assert.deepEqual(failures, []);
});

test("every regex rule in the registry compiles here", () => {
  // An uncompilable regex never matches, so a type that relies on one silently disappears from detection.
  assert.deepEqual(new MagicDetector().uncompilableRegexes, []);
});
