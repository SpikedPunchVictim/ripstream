import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UPSTREAM_DETECTORS,
  UPSTREAM_ENCODING_DETECTORS,
  UPSTREAM_PARSERS,
  UPSTREAM_SERVICE_STATS,
} from "../src/index.ts";

test("upstream service registry is populated and deduplicated", () => {
  assert.equal(UPSTREAM_SERVICE_STATS.ref, "3.3.3");
  assert.ok(UPSTREAM_PARSERS.length >= 20);
  assert.ok(UPSTREAM_SERVICE_STATS.parserClasses >= 90);
  assert.ok(UPSTREAM_DETECTORS.length >= 2);
  assert.ok(UPSTREAM_ENCODING_DETECTORS.length >= 1);

  for (const group of UPSTREAM_PARSERS) {
    assert.ok(group.module.length > 0);
    assert.equal(new Set(group.classes).size, group.classes.length);
  }

  const parsers = new Set(UPSTREAM_PARSERS.flatMap((group) => group.classes));
  assert.ok(
    [...parsers].some((name) => name.endsWith(".PDFParser")),
    "PDFParser must be present",
  );
});
