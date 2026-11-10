import assert from "node:assert/strict";
import { test } from "node:test";
import { RipstreamConfigError, loadConfig } from "../src/index.ts";
import { MAX_JSON_DEPTH, jsonStructureIssues } from "../src/json-structure.ts";

/*
 * JSON.parse keeps the last of two equal keys and says nothing, so `{"isolation":{"mode":"strict","mode":"off"}}`
 * loaded as `off` with no sign that the first value had been written (tasks/parity/audits/config-inventory.json,
 * C23). It also builds any nesting it is given. A configuration file is two levels deep, so both are refused.
 */

const nest = (depth: number): string => "[".repeat(depth) + "]".repeat(depth);

test("a document with no repeated keys and ordinary depth has no issues", () => {
  assert.deepEqual(jsonStructureIssues('{"version":1,"isolation":{"mode":"strict","maxQueue":0}}'), []);
  assert.deepEqual(jsonStructureIssues("{}"), []);
  assert.deepEqual(jsonStructureIssues("[]"), []);
  assert.deepEqual(jsonStructureIssues("5"), []);
});

test("a repeated key is refused by name, at any depth", () => {
  assert.deepEqual(jsonStructureIssues('{"version":1,"version":2}'), [`duplicate key "version"`]);
  assert.deepEqual(jsonStructureIssues('{"isolation":{"mode":"strict","mode":"off"}}'), [`duplicate key "mode"`]);
  assert.deepEqual(jsonStructureIssues('{"a":[{"k":1,"k":2}]}'), [`duplicate key "k"`]);
});

test("the same key in two different objects is not a repeat", () => {
  assert.deepEqual(jsonStructureIssues('{"a":{"k":1},"b":{"k":2},"c":[{"k":3},{"k":4}]}'), []);
});

test("two spellings of one key are a repeat: the escape is decoded first", () => {
  assert.deepEqual(jsonStructureIssues('{"version":1,"\\u0076ersion":2}'), [`duplicate key "version"`]);
  assert.deepEqual(jsonStructureIssues('{"a\\"b":1,"a\\"b":2}'), [`duplicate key "a\\"b"`]);
});

test("a string value that looks like a key is not one", () => {
  assert.deepEqual(jsonStructureIssues('{"a":"a","b":["a","a"],"c":"a"}'), []);
  assert.deepEqual(jsonStructureIssues('{"a":"x, \\"y\\": {","b":1}'), []);
});

test("every repeated key is reported once", () => {
  assert.deepEqual(jsonStructureIssues('{"a":1,"a":2,"a":3,"b":1,"b":2}'), [`duplicate key "a"`, `duplicate key "b"`]);
});

test(`nesting deeper than ${MAX_JSON_DEPTH} levels is refused; ${MAX_JSON_DEPTH} is allowed`, () => {
  assert.deepEqual(jsonStructureIssues(nest(MAX_JSON_DEPTH)), []);
  assert.deepEqual(jsonStructureIssues(nest(MAX_JSON_DEPTH + 1)), [`nesting is deeper than ${MAX_JSON_DEPTH} levels`]);
  assert.deepEqual(jsonStructureIssues(`{"a":${nest(MAX_JSON_DEPTH)}}`), [`nesting is deeper than ${MAX_JSON_DEPTH} levels`]);
});

test("hostile depth costs a refusal, not a stack overflow", () => {
  assert.deepEqual(jsonStructureIssues(nest(1_000_000)), [`nesting is deeper than ${MAX_JSON_DEPTH} levels`]);
});

test("loadConfig refuses a repeated key and names it", () => {
  assert.throws(
    () => loadConfig('{"isolation":{"mode":"strict","mode":"off"}}'),
    (error: unknown) => error instanceof RipstreamConfigError && /duplicate key "mode"/.test(error.message),
  );
  assert.throws(() => loadConfig('{"version":1,"version":1}'), /duplicate key "version"/);
  assert.throws(() => loadConfig(new TextEncoder().encode('{"version":1,"version":2}')), /duplicate key "version"/);
});

test("loadConfig refuses excessive nesting", () => {
  assert.throws(
    () => loadConfig(`{"version":1,"isolation":{"mode":"off"},"extra":${nest(100_000)}}`),
    (error: unknown) => error instanceof RipstreamConfigError && new RegExp(`deeper than ${MAX_JSON_DEPTH}`).test(error.message),
  );
});

test("loadConfig reports a repeated key together with the other problems", () => {
  assert.throws(
    () => loadConfig('{"version":1,"version":2,"bogus":true}'),
    (error: unknown) =>
      error instanceof RipstreamConfigError && /duplicate key "version"/.test(error.message) && /unknown top-level key "bogus"/.test(error.message),
  );
});

test("loadConfig still takes a valid document, and an object that was never text", () => {
  assert.equal(loadConfig('{"version":3,"isolation":{"mode":"off"}}').version, 3);
  assert.equal(loadConfig({ version: 4 }).version, 4);
});
