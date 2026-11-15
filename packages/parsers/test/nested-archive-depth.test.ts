import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import { LimitExceededError } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

/*
 * What a zip nested N deep gives under the default limits (maxNodeDepth 100), for docs/limits-and-statuses.md: a plain
 * `parse` throws once a document would sit deeper than the limit, `parseRecursive` resolves with the documents down to the
 * limit and records the refusal on the deepest one.
 */

const ripstream = createRipstream();
const leaf = new TextEncoder().encode("the innermost text");

function nested(levels: number): Uint8Array {
  let bytes: Uint8Array = leaf;
  for (let level = levels; level >= 1; level -= 1) bytes = zipSync({ [`level-${level}.zip`]: [bytes, { level: 0 }] });
  return bytes;
}

for (const levels of [21, 50, 100]) {
  test(`a zip nested ${levels} deep is read to the innermost document`, async () => {
    const bytes = nested(levels);
    const parsed = await ripstream.parse(bytes, { filename: "outer.zip" });
    assert.match(parsed.text, /the innermost text/);
    const records = await ripstream.parseRecursive(bytes, { filename: "outer.zip" });
    assert.equal(records.length, levels + 1);
    assert.equal(Math.max(...records.map((record) => record.depth)), levels);
    assert.ok(records.every((record) => record.exception === null));
    assert.match(records.at(-1)!.content, /the innermost text/);
  });
}

for (const levels of [101, 200]) {
  test(`a zip nested ${levels} deep: parse throws, parseRecursive stops at depth 100 and records why`, async () => {
    const bytes = nested(levels);
    await assert.rejects(ripstream.parse(bytes, { filename: "outer.zip" }), (error: unknown) => {
      assert.ok(error instanceof LimitExceededError);
      assert.equal(error.message, "Embedded depth 101 exceeds 100");
      return true;
    });
    for (const onDocumentFailure of ["throw", "record"] as const) {
      const records = await ripstream.parseRecursive(bytes, { filename: "outer.zip", onDocumentFailure });
      assert.equal(records.length, 101);
      const deepest = records.at(-1)!;
      assert.equal(deepest.depth, 100);
      assert.ok(deepest.exception instanceof LimitExceededError);
      assert.deepEqual(deepest.metadata.getAll("tk:exception:embedded-exception"), ["LimitExceededError: Embedded depth 101 exceeds 100"]);
      assert.equal(records[0]!.exception, null);
      assert.ok(records.every((record) => !record.content.includes("the innermost text")));
    }
  });
}

test("a limit set to 0 refuses the first embedded document even to parseRecursive, where a deeper limit records it", async () => {
  const bytes = nested(3);
  await assert.rejects(ripstream.parseRecursive(bytes, { filename: "outer.zip", limits: { maxNodeDepth: 0 }, onDocumentFailure: "record" }), LimitExceededError);
  const records = await ripstream.parseRecursive(bytes, { filename: "outer.zip", limits: { maxNodeDepth: 1 } });
  assert.deepEqual(records.map((record) => [record.depth, record.exception === null]), [[0, true], [1, false]]);
});
