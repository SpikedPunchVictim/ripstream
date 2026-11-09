import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UPSTREAM_COMPONENTS,
  UPSTREAM_DETECTORS,
  UPSTREAM_ENCODING_DETECTORS,
  UPSTREAM_PARSERS,
  UPSTREAM_SERVICE_STATS,
} from "../src/index.ts";

test("upstream service registry is populated and deduplicated", () => {
  assert.equal(UPSTREAM_SERVICE_STATS.ref, "4.2.0");
  assert.ok(UPSTREAM_PARSERS.length >= 20);
  // The 4.2.0 standard server loads 89 parsers; extended modules add more.
  assert.ok(UPSTREAM_SERVICE_STATS.parserClasses >= 89);
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

test("upstream components cover every index kind, once each", () => {
  const keys = UPSTREAM_COMPONENTS.map((c) => `${c.kind}\0${c.class}`);
  assert.equal(new Set(keys).size, keys.length, "a class appears twice in one kind");
  for (const kind of ["parsers", "detectors", "renderers", "metadata-filters", "language-detectors", "parse-context"]) {
    assert.ok(
      UPSTREAM_COMPONENTS.some((c) => c.kind === kind),
      `no component of kind ${kind}`,
    );
  }
  assert.equal(UPSTREAM_SERVICE_STATS.components, UPSTREAM_COMPONENTS.length);
});

test("opt-in components are not in the default registry", () => {
  const defaults = new Set(UPSTREAM_PARSERS.flatMap((group) => group.classes));
  for (const c of UPSTREAM_COMPONENTS) {
    if (c.kind === "parsers" && !c.spi) assert.ok(!defaults.has(c.class), `${c.class} is opt-in`);
  }
});

test("name-based lookup names are kebab-case unless set explicitly", () => {
  const pdf = UPSTREAM_COMPONENTS.find((c) => c.class === "org.apache.tika.parser.pdf.PDFParser");
  assert.ok(pdf !== undefined);
  assert.equal(pdf.name, "pdf-parser");
  assert.equal(pdf.source, "annotation");
});
