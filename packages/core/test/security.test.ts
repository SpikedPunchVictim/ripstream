import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Metadata,
  UnsafePatternError,
  compileSafeRegex,
  redactMetadata,
  safeRegexTest,
} from "../src/index.ts";

test("redacts credential-like metadata values", () => {
  const metadata = new Metadata();
  metadata.set("Password", "hunter2");
  metadata.set("api-key", "abc");
  metadata.set("Authorization", "Bearer x");
  metadata.set("dc:title", "Keep me");
  redactMetadata(metadata);
  assert.equal(metadata.get("Password"), "[redacted]");
  assert.equal(metadata.get("api-key"), "[redacted]");
  assert.equal(metadata.get("Authorization"), "[redacted]");
  assert.equal(metadata.get("dc:title"), "Keep me");
});

test("redaction supports extra keys and custom replacement", () => {
  const metadata = new Metadata({ "X-Custom": "value" });
  redactMetadata(metadata, { extraKeys: ["x-custom"], replacement: "***" });
  assert.equal(metadata.get("X-Custom"), "***");
});

test("rejects catastrophic regex shapes", () => {
  assert.throws(() => compileSafeRegex("(a+)+$"), UnsafePatternError);
  assert.throws(() => compileSafeRegex("(a|aa)*b"), UnsafePatternError);
  assert.throws(() => compileSafeRegex("a".repeat(1_001)), UnsafePatternError);
  assert.throws(() => compileSafeRegex("("), UnsafePatternError);
  assert.equal(compileSafeRegex("^[a-z]+$").test("abc"), true);
});

test("caps regex input size", () => {
  assert.equal(safeRegexTest("^a+$", "aaa"), true);
  assert.throws(
    () => safeRegexTest("^a+$", "a".repeat(10), "", { maxInputLength: 5 }),
    UnsafePatternError,
  );
});
