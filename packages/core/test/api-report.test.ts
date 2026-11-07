import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface Report {
  readonly formatVersion: 1;
  readonly packages: Readonly<Record<string, readonly string[]>>;
}

const report = JSON.parse(
  readFileSync(new URL("../../../api-report.json", import.meta.url), "utf8"),
) as Report;

test("API report covers every package with unique exports", () => {
  assert.equal(report.formatVersion, 1);
  assert.ok(Object.keys(report.packages).length >= 9);
  for (const [name, exports] of Object.entries(report.packages)) {
    assert.ok(exports.length > 0, name);
    assert.equal(new Set(exports).size, exports.length, name);
  }
});

test("core API includes the stable facade contracts", () => {
  const core = report.packages.core ?? [];
  for (const name of [
    "Ripstream",
    "MediaType",
    "Metadata",
    "ParseContext",
    "Parser",
    "Detector",
    "XHTMLContentHandler",
    "runIsolatedTask",
    "safeFetch",
  ]) {
    assert.ok(core.includes(name), name);
  }
});
