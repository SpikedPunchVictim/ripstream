import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAzBlobEmitter, parseAzBlobFetcher, parseAzBlobIterator } from "../src/pipes-azblob-config.ts";

/*
 * Tika's az-blob-fetcher, az-blob-emitter and az-blob-pipes-iterator (tika-pipes-az-blob 4.2.0), as a configuration gives
 * them (tikajs-68os.32). The rules are those of AZBlobFetcher.initialize(), AZBlobEmitterConfig.validate() and
 * AZBlobPipesIterator.checkConfig(): a SAS token, an endpoint and a container, and no key the config classes do not have.
 */

const ENDPOINT = "https://myaccount.blob.core.windows.net";
const BASE = { sasToken: "sv=2022-11-02&sig=abc", endpoint: ENDPOINT, container: "docs" };
const AZURE = { sasToken: "sv=2022-11-02&sig=abc", endpoint: ENDPOINT, container: "docs" };

function read<T>(parse: (context: { at: string; issues: string[]; notices: string[] }) => T): { result: T; issues: string[]; notices: string[] } {
  const issues: string[] = [];
  const notices: string[] = [];
  return { result: parse({ at: "c", issues, notices }), issues, notices };
}

test("a fetcher needs a SAS token, an endpoint and a container; with one of them set Tika wants all three", () => {
  assert.deepEqual(read((context) => parseAzBlobFetcher("f", BASE, context)).result, { id: "f", type: "az-blob-fetcher", azure: AZURE });
  assert.deepEqual(read((context) => parseAzBlobFetcher("f", { endpoint: ENDPOINT }, context)).issues, [
    "c.sasToken is required and must be a non-empty string",
    "c.container is required and must be a non-empty string",
  ]);
  assert.deepEqual(read((context) => parseAzBlobFetcher("f", { ...BASE, container: "  " }, context)).issues, ["c.container is required and must be a non-empty string"]);
  assert.deepEqual(read((context) => parseAzBlobFetcher("f", { ...BASE, sasToken: "?" }, context)).issues, ["c.sasToken is required and must be a non-empty string"]);
});

test("a fetcher with none of the three is refused: Tika then reads the fetch key as a connection string, which ripstream does not", () => {
  const { result, issues } = read((context) => parseAzBlobFetcher("f", {}, context));
  assert.equal(result, undefined);
  assert.equal(issues.length, 1);
  assert.match(issues[0] ?? "", /^c has none of sasToken, endpoint and container: Tika then .*connection string.*ripstream does not/);
});

test("a key the config classes do not have is refused, as Tika's strict mapper refuses it", () => {
  const { issues } = read((context) => parseAzBlobFetcher("f", { ...BASE, accountKey: "k", prefix: "in/" }, context));
  assert.deepEqual(issues, [
    "c.accountKey is not a setting ripstream has (it reads sasToken, endpoint, container, spoolToTemp, extractUserMetadata)",
    "c.prefix is not a setting ripstream has (it reads sasToken, endpoint, container, spoolToTemp, extractUserMetadata)",
  ]);
});

test("what a fetcher accepts and changes nothing is said so: spoolToTemp false, and extractUserMetadata, which is true unless set", () => {
  assert.deepEqual(read((context) => parseAzBlobFetcher("f", BASE, context)).notices.map((notice) => notice.split(" ")[0]), ["c.extractUserMetadata"]);
  const off = read((context) => parseAzBlobFetcher("f", { ...BASE, spoolToTemp: false, extractUserMetadata: false }, context));
  assert.deepEqual(off.notices.map((notice) => notice.split(" ")[0]), ["c.spoolToTemp"]);
  assert.match(read((context) => parseAzBlobFetcher("f", { ...BASE, spoolToTemp: "yes" }, context)).issues[0] ?? "", /spoolToTemp must be a boolean/);
});

test("an endpoint is an absolute http or https URL with no query, fragment or credentials", () => {
  const problem = (endpoint: unknown): string[] => read((context) => parseAzBlobFetcher("f", { ...BASE, endpoint }, context)).issues;
  assert.deepEqual(problem(ENDPOINT), []);
  assert.deepEqual(problem("http://127.0.0.1:10000/devstoreaccount1"), []);
  for (const bad of ["myaccount.blob.core.windows.net", "ftp://x/y", `${ENDPOINT}?sv=1&sig=x`, `${ENDPOINT}#frag`, "https://user:pw@myaccount.blob.core.windows.net", "not a url"]) {
    assert.match(problem(bad)[0] ?? "", /^c\.endpoint must be an absolute http or https URL with no query, fragment or credentials/, bad);
  }
  assert.deepEqual(problem(3), ["c.endpoint is required and must be a non-empty string"]);
});

test("an emitter needs all three, and its fileExtension is json unless set, a blank one is none, and the prefix loses one trailing slash", () => {
  const emitter = (config: Record<string, unknown>) => read((context) => parseAzBlobEmitter("e", { ...BASE, ...config }, context)).result;
  assert.deepEqual(emitter({}), { id: "e", type: "az-blob-emitter", azure: AZURE, fileExtension: "json" });
  assert.equal(emitter({ fileExtension: "" })?.fileExtension, undefined);
  assert.equal(emitter({ fileExtension: "ndjson" })?.fileExtension, "ndjson");
  assert.equal(emitter({ prefix: "out/" })?.prefix, "out");
  assert.equal(emitter({ prefix: "a//" })?.prefix, "a/");
  assert.equal(emitter({ prefix: "/" })?.prefix, undefined);
  assert.equal(emitter({ prefix: "" })?.prefix, undefined);
  assert.deepEqual(read((context) => parseAzBlobEmitter("e", {}, context)).issues, [
    "c.sasToken is required and must be a non-empty string",
    "c.endpoint is required and must be a non-empty string",
    "c.container is required and must be a non-empty string",
  ]);
  assert.deepEqual(read((context) => parseAzBlobEmitter("e", { ...BASE, prefix: 3, fileExtension: false }, context)).issues, [
    "c.prefix must be a string without a NUL byte",
    "c.fileExtension must be a string without a NUL byte",
  ]);
});

test("an emitter's overwriteExisting is false unless set, and must be a boolean", () => {
  assert.equal(read((context) => parseAzBlobEmitter("e", BASE, context)).result?.overwriteExisting, undefined);
  assert.equal(read((context) => parseAzBlobEmitter("e", { ...BASE, overwriteExisting: false }, context)).result?.overwriteExisting, undefined);
  assert.equal(read((context) => parseAzBlobEmitter("e", { ...BASE, overwriteExisting: true }, context)).result?.overwriteExisting, true);
  assert.deepEqual(read((context) => parseAzBlobEmitter("e", { ...BASE, overwriteExisting: "true" }, context)).issues, ["c.overwriteExisting must be a boolean"]);
  assert.match(read((context) => parseAzBlobEmitter("e", { ...BASE, extractUserMetadata: true }, context)).issues[0] ?? "", /extractUserMetadata is not a setting ripstream has \(it reads sasToken, endpoint, container, prefix, fileExtension, overwriteExisting\)/);
});

test("an iterator names its fetcher and emitter and has the three settings, a prefix and a timeoutMillis", () => {
  const found = read((context) => parseAzBlobIterator({ ...BASE, prefix: "in/", timeoutMillis: 5000, fetcherId: "f", emitterId: "e" }, context)).result;
  assert.deepEqual(found, { type: "az-blob-pipes-iterator", azure: AZURE, prefix: "in/", timeoutMillis: 5000, fetcherId: "f", emitterId: "e" });
  assert.deepEqual(read((context) => parseAzBlobIterator({ ...BASE, fetcherId: "f", emitterId: "e" }, context)).result, { type: "az-blob-pipes-iterator", azure: AZURE, fetcherId: "f", emitterId: "e" });
  const missing = read((context) => parseAzBlobIterator({}, context));
  assert.equal(missing.result, undefined);
  assert.deepEqual(missing.issues, [
    "c.fetcherId is required and must be a non-empty string",
    "c.emitterId is required and must be a non-empty string",
    "c.sasToken is required and must be a non-empty string",
    "c.endpoint is required and must be a non-empty string",
    "c.container is required and must be a non-empty string",
  ]);
});

test("an iterator's timeoutMillis is a whole number of milliseconds a timer can hold", () => {
  const problem = (timeoutMillis: unknown): string[] => read((context) => parseAzBlobIterator({ ...BASE, fetcherId: "f", emitterId: "e", timeoutMillis }, context)).issues;
  assert.deepEqual(problem(1), []);
  assert.deepEqual(problem(2147483647), []);
  assert.deepEqual(problem(null), [], "null is as good as absent in a JSON configuration");
  for (const bad of [0, -1, 1.5, 2147483648, "5000", Number.NaN]) {
    assert.deepEqual(problem(bad), ["c.timeoutMillis must be a whole number of milliseconds from 1 to 2147483647"], String(bad));
  }
  assert.deepEqual(read((context) => parseAzBlobIterator({ ...BASE, fetcherId: "f", emitterId: "e", fileNamePattern: "x" }, context)).issues, [
    "c.fileNamePattern is not a setting ripstream has (it reads sasToken, endpoint, container, prefix, timeoutMillis, fetcherId, emitterId)",
  ]);
});
