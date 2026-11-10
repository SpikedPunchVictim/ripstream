import assert from "node:assert/strict";
import { test } from "node:test";
import { RipstreamConfigError } from "@spikedpunch/ripstream-core";
import { MemoryEmitter, PipesClient, PipesEngine, createEngine, validatePipesConfig, type Fetcher } from "../src/index.ts";

/*
 * A pipes configuration that is wrong used to run anyway (tasks/parity/audits/config-inventory.json, E02-E06): an
 * unknown key was dropped, a string for `concurrency` or a bogus `mode` was passed on, and a `sink.type` other than
 * "filesystem" was written to the filesystem. Each is now refused, by name, before any document is fetched.
 */

const SOURCE = { type: "filesystem", path: "." } as const;
const issues = (config: unknown): string => validatePipesConfig(config).join(" | ");

test("a valid configuration has no issues", () => {
  assert.deepEqual(validatePipesConfig({ source: SOURCE }), []);
  assert.deepEqual(
    validatePipesConfig({
      source: { type: "http", urls: ["http://example.com/a"] },
      sink: { type: "filesystem", path: "out" },
      mode: "RMETA",
      concurrency: 8,
      maxQueue: 1,
      ordered: true,
      followSymlinks: false,
    }),
    [],
  );
  assert.deepEqual(validatePipesConfig({ source: { type: "filesystem" } }), []);
});

test("the configuration must be an object with a source", () => {
  for (const config of [null, undefined, "x", 5, [], true]) {
    assert.match(issues(config), /configuration must be an object/, String(config));
  }
  assert.match(issues({}), /source is required/);
  for (const source of [null, "fs", 5, [], true]) {
    assert.match(issues({ source }), /source must be an object/, String(source));
  }
});

test("an unknown key is refused by name", () => {
  assert.match(issues({ source: SOURCE, concurency: 4 }), /unknown key "concurency"/);
  assert.match(issues({ source: { ...SOURCE, paht: "x" } }), /unknown key "paht" in source/);
  assert.match(issues({ source: SOURCE, sink: { type: "filesystem", path: "o", mode: "w" } }), /unknown key "mode" in sink/);
});

test("mode is one of the five modes", () => {
  for (const mode of ["rmeta", "BOGUS", "", 3, null, {}]) {
    assert.match(issues({ source: SOURCE, mode }), /mode must be one of CONTENT_ONLY, CONCATENATE, RMETA, NO_PARSE, UNPACK/, String(mode));
  }
  for (const mode of ["CONTENT_ONLY", "CONCATENATE", "RMETA", "NO_PARSE", "UNPACK"]) {
    assert.deepEqual(validatePipesConfig({ source: SOURCE, mode }), [], mode);
  }
});

test("concurrency and maxQueue are positive integers", () => {
  for (const key of ["concurrency", "maxQueue"]) {
    for (const value of ["4", Number.NaN, 0, -1, 1.5, Infinity, null, true, 2 ** 53]) {
      assert.match(issues({ source: SOURCE, [key]: value }), new RegExp(`${key} must be a positive integer`), `${key}: ${String(value)}`);
    }
    assert.deepEqual(validatePipesConfig({ source: SOURCE, [key]: 1 }), []);
  }
});

test("ordered and followSymlinks are booleans", () => {
  for (const key of ["ordered", "followSymlinks"]) {
    for (const value of ["true", 1, 0, null, {}]) {
      assert.match(issues({ source: SOURCE, [key]: value }), new RegExp(`${key} must be a boolean`), `${key}: ${String(value)}`);
    }
  }
});

test("source.type must be filesystem or http: nothing falls back to the filesystem", () => {
  for (const type of ["s3", "FILESYSTEM", "", undefined, 5, null]) {
    assert.match(issues({ source: { type, path: "." } }), /source\.type must be "filesystem" or "http"/, String(type));
  }
});

test("source keys must fit the source type", () => {
  assert.match(issues({ source: { type: "filesystem", path: 5 } }), /source\.path must be a non-empty string/);
  assert.match(issues({ source: { type: "filesystem", path: "" } }), /source\.path must be a non-empty string/);
  assert.match(issues({ source: { type: "filesystem", urls: ["http://a/"] } }), /unknown key "urls" in source/);
  assert.match(issues({ source: { type: "http", path: "/tmp" } }), /unknown key "path" in source/);
  assert.match(issues({ source: { type: "http", urls: "http://a/" } }), /source\.urls must be an array of strings/);
  assert.match(issues({ source: { type: "http", urls: [1] } }), /source\.urls must be an array of strings/);
});

test("sink.type must be filesystem and sink.path a string", () => {
  for (const type of ["s3", "gcs", "", undefined, 5]) {
    assert.match(issues({ source: SOURCE, sink: { type, path: "out" } }), /sink\.type must be "filesystem"/, String(type));
  }
  for (const path of [undefined, "", 5, null]) {
    assert.match(issues({ source: SOURCE, sink: { type: "filesystem", path } }), /sink\.path must be a non-empty string/, String(path));
  }
  for (const sink of [null, "out", 5, []]) {
    assert.match(issues({ source: SOURCE, sink }), /sink must be an object/, String(sink));
  }
});

test("every problem is reported at once", () => {
  const all = issues({ source: { type: "s3" }, mode: "x", concurrency: -1, extra: 1 });
  for (const part of [/source\.type/, /mode/, /concurrency/, /unknown key "extra"/]) assert.match(all, part);
});

test("createEngine and PipesClient refuse a bad configuration up front", () => {
  const bad = { source: { type: "s3", path: "." }, concurrency: "4" } as never;
  assert.throws(() => createEngine(bad), RipstreamConfigError);
  assert.throws(() => new PipesClient(bad), RipstreamConfigError);
  assert.throws(
    () => createEngine({ source: SOURCE, sink: { type: "s3", path: "out" } } as never),
    (error: unknown) => error instanceof RipstreamConfigError && /sink\.type must be "filesystem"/.test(error.message),
  );
});

const noDocuments: Fetcher = { fetch: async function* () {} };

test("PipesEngine refuses options that would stall or run unbounded", () => {
  const options = { fetcher: noDocuments, emitter: new MemoryEmitter() };
  for (const key of ["concurrency", "maxQueue", "maxBuffered"]) {
    for (const value of [Number.NaN, 0, -1, 1.5, Infinity, "4"]) {
      assert.throws(
        () => new PipesEngine({ ...options, [key]: value } as never),
        (error: unknown) => error instanceof RangeError && error.message.includes(key),
        `${key}: ${String(value)}`,
      );
    }
  }
  assert.throws(() => new PipesEngine({ ...options, mode: "BOGUS" } as never), /mode must be one of/);
  assert.throws(() => new PipesEngine({ ...options, ordered: "yes" } as never), /ordered must be a boolean/);
  assert.throws(() => new PipesEngine({ ...options, limits: { maxNodeDepth: Number.NaN } }), /maxNodeDepth/);
  new PipesEngine({ ...options, concurrency: 1, maxQueue: 1, maxBuffered: 1, mode: "UNPACK", ordered: false });
});
