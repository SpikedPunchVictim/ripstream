import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultDetector } from "@spikedpunch/ripstream-mime";
import { RipstreamConfigError, UnsupportedFormatError, loadConfig } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

// A `detectors` section reaches the facade through createRipstream({ config }), the way `parsers` does
// (tikajs-68os.8.6; the section itself is exercised in packages/mime/test/detector-config.test.ts).

const text = new TextEncoder().encode("Hello detectors");

test("createRipstream applies the detectors section: the detector decides what the parser is offered", async () => {
  const bare = createRipstream({ config: loadConfig({ detectors: ["no-op-detector"] }) });
  assert.equal((await bare.detect(text, { filename: "a.txt" })).toString(), "application/octet-stream");
  assert.equal((await createRipstream().detect(text, { filename: "a.txt" })).toString(), "text/plain");
  const named = createRipstream({ config: loadConfig({ detectors: ["mime-types"] }) });
  assert.equal((await named.detect(text, { filename: "a.txt" })).toString(), "text/plain");
});

test("both sections apply together", async () => {
  const ripstream = createRipstream({
    config: loadConfig({ parsers: [{ "default-parser": { exclude: ["text-and-csv-parser"] } }], detectors: ["mime-types"] }),
  });
  assert.equal((await ripstream.detect(text, { filename: "a.txt" })).toString(), "text/plain");
  await assert.rejects(ripstream.parse(text, { filename: "a.txt" }), UnsupportedFormatError);
});

test("a detectors section cannot be combined with an explicit detector", () => {
  assert.throws(
    () => createRipstream({ detector: new DefaultDetector(), config: loadConfig({ detectors: ["mime-types"] }) }),
    (error: unknown) => error instanceof RipstreamConfigError && /cannot be combined with `detector`/.test(error.message),
  );
  // A config with no detectors section still works beside one.
  createRipstream({ detector: new DefaultDetector(), config: loadConfig({}) });
});

test("a detectors section that names what ripstream lacks is an error from createRipstream", () => {
  assert.throws(
    () => createRipstream({ config: loadConfig({ detectors: ["magika-detector"] }) }),
    (error: unknown) => error instanceof RipstreamConfigError && /detector "magika-detector" is not implemented/.test(error.message),
  );
});
