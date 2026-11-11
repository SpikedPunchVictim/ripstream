import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGcsEmitter, parseGcsFetcher, parseGcsIterator } from "../src/pipes-gcs-config.ts";

/*
 * Tika's gcs-fetcher, gcs-emitter and gcs-pipes-iterator (tika-pipes-gcs 4.2.0), as a configuration gives them
 * (tikajs-68os.31). The rules are those of GCSFetcher.initialize(), GCSEmitterConfig.validate() and GCSPipesIterator's
 * constructor: a bucket and a projectId, and no key that the config classes do not have.
 */

const BASE = { projectId: "my-project", bucket: "docs" };

function read<T>(parse: (context: { at: string; issues: string[]; notices: string[] }) => T): { result: T; issues: string[]; notices: string[] } {
  const issues: string[] = [];
  const notices: string[] = [];
  return { result: parse({ at: "c", issues, notices }), issues, notices };
}

test("a gcs-fetcher needs a bucket and a projectId, as Tika's initialize() insists", () => {
  assert.deepEqual(read((context) => parseGcsFetcher("f", BASE, context)).result, { id: "f", type: "gcs-fetcher", gcs: { projectId: "my-project", bucket: "docs" } });
  const empty = read((context) => parseGcsFetcher("f", {}, context));
  assert.equal(empty.result, undefined);
  assert.deepEqual(empty.issues, ["c.bucket is required and must be a non-empty string", "c.projectId is required and must be a non-empty string"]);
  assert.match(read((context) => parseGcsFetcher("f", { ...BASE, bucket: "  " }, context)).issues[0] ?? "", /bucket is required/);
});

test("a key the config classes do not have is refused, as Tika's strict mapper refuses it", () => {
  const { issues } = read((context) => parseGcsFetcher("f", { ...BASE, credentialsProvider: "key_secret", prefix: "in/" }, context));
  assert.deepEqual(issues, [
    "c.credentialsProvider is not a setting ripstream has (it reads projectId, bucket, spoolToTemp, extractUserMetadata)",
    "c.prefix is not a setting ripstream has (it reads projectId, bucket, spoolToTemp, extractUserMetadata)",
  ]);
});

test("what a gcs-fetcher accepts and changes nothing is said so: projectId, spoolToTemp false, and extractUserMetadata, which is true unless set", () => {
  const named = (notices: readonly string[]) => notices.map((notice) => notice.split(" ")[0]).sort();
  const defaults = read((context) => parseGcsFetcher("f", BASE, context));
  assert.deepEqual(named(defaults.notices), ["c.extractUserMetadata", "c.projectId"]);
  const off = read((context) => parseGcsFetcher("f", { ...BASE, spoolToTemp: false, extractUserMetadata: false }, context));
  assert.deepEqual(named(off.notices), ["c.projectId", "c.spoolToTemp"]);
  assert.match(read((context) => parseGcsFetcher("f", { ...BASE, spoolToTemp: "yes" }, context)).issues[0] ?? "", /spoolToTemp must be a boolean/);
});

test("a gcs-emitter's fileExtension is json unless set, a blank one is none, and the prefix loses one trailing slash", () => {
  const emitter = (config: Record<string, unknown>) => read((context) => parseGcsEmitter("e", { ...BASE, ...config }, context)).result;
  assert.equal(emitter({})?.fileExtension, "json");
  assert.equal(emitter({ fileExtension: "" })?.fileExtension, undefined);
  assert.equal(emitter({ fileExtension: "ndjson" })?.fileExtension, "ndjson");
  assert.equal(emitter({ prefix: "out/" })?.prefix, "out");
  assert.equal(emitter({ prefix: "out" })?.prefix, "out");
  assert.equal(emitter({ prefix: "a//" })?.prefix, "a/");
  assert.equal(emitter({ prefix: "" })?.prefix, undefined);
  assert.equal(emitter({ prefix: "/" })?.prefix, undefined);
  assert.deepEqual(read((context) => parseGcsEmitter("e", { ...BASE, prefix: 3, fileExtension: false }, context)).issues, [
    "c.prefix must be a string without a NUL byte",
    "c.fileExtension must be a string without a NUL byte",
  ]);
});

test("a gcs-pipes-iterator names its fetcher and emitter, a prefix, a bucket and a projectId", () => {
  const found = read((context) => parseGcsIterator({ ...BASE, prefix: "in/", fetcherId: "f", emitterId: "e" }, context)).result;
  assert.deepEqual(found, { type: "gcs-pipes-iterator", gcs: { projectId: "my-project", bucket: "docs" }, prefix: "in/", fetcherId: "f", emitterId: "e" });
  const missing = read((context) => parseGcsIterator({}, context));
  assert.equal(missing.result, undefined);
  assert.deepEqual(missing.issues, [
    "c.fetcherId is required and must be a non-empty string",
    "c.emitterId is required and must be a non-empty string",
    "c.bucket is required and must be a non-empty string",
    "c.projectId is required and must be a non-empty string",
  ]);
  assert.deepEqual(read((context) => parseGcsIterator({ ...BASE, fetcherId: "f", emitterId: "e", fileNamePattern: "x" }, context)).issues, [
    "c.fileNamePattern is not a setting ripstream has (it reads projectId, bucket, prefix, fetcherId, emitterId)",
  ]);
});
