import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { UPSTREAM_PARSERS } from "../src/index.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../../../tasks/parser-coverage.json", import.meta.url), "utf8"),
) as {
  version: 1;
  modules: Record<string, { owner: string; status: string }>;
};

test("every upstream parser module has an owner", () => {
  const modules = UPSTREAM_PARSERS.map((group) => group.module);
  assert.ok(modules.length >= 20);
  assert.deepEqual(
    modules.filter((module) => manifest.modules[module] === undefined),
    [],
  );
  assert.deepEqual(
    Object.keys(manifest.modules).filter((module) => !modules.includes(module)),
    [],
  );
  for (const [module, coverage] of Object.entries(manifest.modules)) {
    assert.match(coverage.owner, /^tikajs-[a-z0-9.]+$/, module);
    assert.ok(
      ["implemented", "partial", "planned", "aggregate"].includes(coverage.status),
      module,
    );
  }
  const classCount = UPSTREAM_PARSERS.reduce(
    (sum, group) => sum + group.classes.length,
    0,
  );
  assert.ok(classCount >= 90);
});
