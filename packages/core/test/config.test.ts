import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RipstreamConfig,
  RipstreamConfigError,
  configGeneration,
  loadConfig,
  validateConfig,
} from "../src/index.ts";

test("loads a valid JSON configuration", () => {
  const before = configGeneration();
  const config = loadConfig(
    JSON.stringify({
      version: 1,
      parsers: [{ class: "org.example.Parser", maxDepth: 4 }],
      detectors: [{ class: "org.example.Detector" }],
      encodingDetector: { class: "org.example.Encoding" },
    }),
  );
  assert.ok(config.generation > before);
  assert.equal(config.parsers.length, 1);
  assert.equal(config.parsers[0]?.class, "org.example.Parser");
  assert.equal(config.detectors.length, 1);
  assert.equal(config.encodingDetector?.class, "org.example.Encoding");
  assert.equal(RipstreamConfig.prototype.isPrototypeOf(config), true);
});

test("fails fast with all validation issues", () => {
  const issues = validateConfig({
    unknown: true,
    parsers: [{ maxDepth: 2 }],
    detectors: "nope",
    version: 0,
  });
  assert.equal(issues.length, 4);
  assert.throws(
    () => loadConfig(JSON.stringify({ parsers: [{}] })),
    RipstreamConfigError,
  );
  assert.throws(() => loadConfig("{"), RipstreamConfigError);
});

test("new configurations invalidate previous generations", () => {
  const first = loadConfig({});
  assert.equal(first.current, true);
  const second = loadConfig({});
  assert.equal(first.current, false);
  assert.equal(second.current, true);
});

test("loads legacy XML component lists", async () => {
  const { loadXmlConfig } = await import("../src/index.ts");
  const config = loadXmlConfig(
    '<properties><parsers><parser class="a.Parser"/></parsers><detectors><detector class="b.Detector"/></detectors><encodingDetector class="c.Encoding"/></properties>',
  );
  assert.equal(config.parsers[0]?.class, "a.Parser");
  assert.equal(config.detectors[0]?.class, "b.Detector");
  assert.equal(config.encodingDetector?.class, "c.Encoding");
  assert.throws(() => loadXmlConfig("<bad/>"), RipstreamConfigError);
});
