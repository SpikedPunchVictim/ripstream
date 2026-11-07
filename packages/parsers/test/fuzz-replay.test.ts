import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RipstreamError } from "@spikedpunch/ripstream-core";
import { loadCorpus, loadManifest } from "@spikedpunch/ripstream-test-corpus";
import { createRipstream } from "../src/index.ts";

const manifest = loadManifest(
  readFileSync(
    new URL("../../test-corpus/corpus.manifest.json", import.meta.url),
    "utf8",
  ),
);
const corpus = loadCorpus(manifest, ".");

test("adversarial corpus is handled without unexpected errors", async () => {
  const ripstream = createRipstream();
  const adversarial = corpus.filter((item) =>
    ["xml-truncated", "utf8-invalid", "xml-deep"].includes(item.id),
  );
  assert.equal(adversarial.length, 3);
  for (const item of adversarial) {
    try {
      await ripstream.parse(item.bytes, { filename: `${item.id}.bin` });
    } catch (error) {
      assert.ok(error instanceof RipstreamError, `${item.id}: ${String(error)}`);
    }
  }
});

test("mutation replay stays within Tika errors", async () => {
  const ripstream = createRipstream();
  const seed = new TextEncoder().encode("<html><body>seed</body></html>");
  for (let round = 0; round < 20; round++) {
    const mutated = new Uint8Array(seed);
    mutated[round % mutated.length] ^= 0xff;
    try {
      await ripstream.parse(mutated, { filename: "mutated.html" });
    } catch (error) {
      assert.ok(error instanceof RipstreamError, String(error));
    }
  }
});
