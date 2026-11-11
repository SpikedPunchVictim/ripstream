import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata } from "@spikedpunch/ripstream-core";
import { check, validateFixture, type FieldView } from "./fixture-runner.ts";

const metadata = new Metadata();
metadata.set("Content-Type", "text/plain");
metadata.set("dc:title", "T");
const view: FieldView = { text: "hello world", metadata };

test("equals passes on a match and names field and assertion on a mismatch", () => {
  check(view, { type: "equals", field: "text", value: "hello world" });
  assert.throws(() => check(view, { type: "equals", field: "text", value: "nope" }), /text equals/);
});

test("metadata fields are read by key, colons included", () => {
  check(view, { type: "equals", field: "metadata.dc:title", value: "T" });
});

test("absent passes for an unset metadata key and fails for a set one", () => {
  check(view, { type: "absent", field: "metadata.Content-Encoding" });
  assert.throws(() => check(view, { type: "absent", field: "metadata.dc:title" }), /absent/);
});

test("a value assertion on an unset field fails as absent, not as a mismatch", () => {
  assert.throws(() => check(view, { type: "equals", field: "metadata.nope", value: "x" }), /field is absent/);
});

test("contains, not_contains, matches, min_length, max_length", () => {
  check(view, { type: "contains", field: "text", value: "lo wo" });
  check(view, { type: "not_contains", field: "text", value: "xyz" });
  check(view, { type: "matches", field: "text", value: "^hello" });
  check(view, { type: "min_length", field: "text", value: 11 });
  check(view, { type: "max_length", field: "text", value: 11 });
  assert.throws(() => check(view, { type: "contains", field: "text", value: "xyz" }), /not found/);
  assert.throws(() => check(view, { type: "not_contains", field: "text", value: "hello" }), /found in/);
  assert.throws(() => check(view, { type: "min_length", field: "text", value: 12 }), /length 11 < 12/);
  assert.throws(() => check(view, { type: "max_length", field: "text", value: 10 }), /length 11 > 10/);
});

test("an unknown field or one the operation does not produce throws", () => {
  assert.throws(() => check(view, { type: "equals", field: "bogus", value: "x" }), /unknown field/);
  assert.throws(() => check(view, { type: "equals", field: "mediaType", value: "x" }), /not available/);
});

const valid = { description: "d", input: { text: "x" }, assertions: [{ type: "absent", field: "text" }] };

test("validateFixture accepts a well-formed fixture", () => {
  assert.equal(validateFixture(valid, "f.json").description, "d");
});

test("validateFixture names the file and the problem", () => {
  assert.throws(() => validateFixture({ ...valid, description: "" }, "a.json"), /a\.json: description is required/);
  assert.throws(() => validateFixture({ ...valid, input: { text: "x", file: "y" } }, "a.json"), /exactly one of/);
  assert.throws(() => validateFixture({ ...valid, input: {} }, "a.json"), /exactly one of/);
  assert.throws(() => validateFixture({ ...valid, assertions: [] }, "a.json"), /non-empty/);
  assert.throws(() => validateFixture({ ...valid, assertions: [{ type: "eq", field: "text", value: "x" }] }, "a.json"), /unknown assertion type "eq"/);
  assert.throws(() => validateFixture({ ...valid, assertions: [{ type: "min_length", field: "text", value: "3" }] }, "a.json"), /needs a number/);
  assert.throws(() => validateFixture({ ...valid, operation: "extract" }, "a.json"), /operation must be/);
});
