import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, parseUnpackConfig, validateConfig } from "../src/index.ts";

/*
 * `parse-context.unpack-config` is Tika's UnpackConfig (tika-pipes-core 4.2.0): what pipes' UNPACK mode emits. ripstream
 * reads the twelve settings it can honor, refuses the ones it cannot by name with the reason, and passes the result on as
 * `pipes.unpack`, with every key absent that the configuration leaves out so the engine's (Tika's) defaults apply.
 */

const PIPES = {
  fetchers: { fsf: { "file-system-fetcher": { basePath: "/in" } } },
  emitters: { fse: { "file-system-emitter": { basePath: "/out" } } },
  "pipes-iterator": { "file-system-pipes-iterator": { basePath: "/in", fetcherId: "fsf", emitterId: "fse" } },
  pipes: { parseMode: "UNPACK" },
};

const unpackOf = (unpackConfig: unknown) => loadConfig({ ...PIPES, "parse-context": { "unpack-config": unpackConfig } }).pipes?.unpack;
const issuesOf = (unpackConfig: unknown): string[] => validateConfig({ ...PIPES, "parse-context": { "unpack-config": unpackConfig } });

test("a configuration with no unpack-config leaves the settings absent", () => {
  assert.equal(loadConfig(PIPES).pipes?.unpack, undefined);
  assert.equal(unpackOf({}) === undefined, false, "an empty unpack-config is an object of no keys");
  assert.deepEqual(unpackOf({}), {});
});

test("every setting ripstream honors is read", () => {
  const given = {
    outputFormat: "REGULAR",
    outputMode: "DIRECTORY",
    suffixStrategy: "DETECTED",
    zeroPadName: 4,
    embeddedIdPrefix: "_",
    keyBaseStrategy: "CUSTOM",
    emitKeyBase: "out/doc",
    includeOriginal: true,
    includeMetadata: false,
    packageRoot: "pkg",
    packageName: "mine",
    maxUnpackBytes: 1024,
  };
  assert.deepEqual(unpackOf(given), given);
});

test("an enum is read in any case, as Tika's does, and kept in its own", () => {
  assert.deepEqual(unpackOf({ outputFormat: "regular", outputMode: "Directory", suffixStrategy: "existing", keyBaseStrategy: "custom" }), {
    outputFormat: "REGULAR",
    outputMode: "DIRECTORY",
    suffixStrategy: "EXISTING",
    keyBaseStrategy: "CUSTOM",
  });
});

test("an empty package root and an empty package name are values, not absent", () => {
  assert.deepEqual(unpackOf({ packageRoot: "", packageName: "" }), { packageRoot: "", packageName: "" });
});

test("a setting ripstream cannot honor is refused by name, with the reason", () => {
  for (const key of ["emitter", "zipEmbeddedFiles", "emptyPackage", "includeMetadataInZip", "includeFullMetadata"]) {
    const issues = issuesOf({ [key]: true });
    assert.equal(issues.length, 1, key);
    assert.match(issues[0] ?? "", new RegExp(`unpack-config: ${key} is not supported: .{20,}`), key);
  }
});

test("a key that is not an UnpackConfig setting is unknown", () => {
  assert.deepEqual(issuesOf({ outputFormt: "REGULAR" }), ['parse-context unpack-config: unknown setting "outputFormt"']);
});

test("an enum outside its names, and a value of the wrong type, are issues that say what is allowed", () => {
  assert.deepEqual(issuesOf({ outputFormat: "TAR" }), ["parse-context unpack-config: outputFormat must be one of FRICTIONLESS, REGULAR"]);
  assert.deepEqual(issuesOf({ outputMode: 3 }), ["parse-context unpack-config: outputMode must be one of ZIPPED, DIRECTORY"]);
  assert.deepEqual(issuesOf({ suffixStrategy: "ALL" }), ["parse-context unpack-config: suffixStrategy must be one of NONE, EXISTING, DETECTED"]);
  assert.deepEqual(issuesOf({ keyBaseStrategy: null }), ["parse-context unpack-config: keyBaseStrategy must be one of DEFAULT, CUSTOM"]);
  assert.deepEqual(issuesOf({ includeOriginal: "yes" }), ["parse-context unpack-config: includeOriginal must be a boolean"]);
  assert.deepEqual(issuesOf({ includeMetadata: 1 }), ["parse-context unpack-config: includeMetadata must be a boolean"]);
  assert.match(issuesOf({ packageRoot: 5 })[0] ?? "", /packageRoot must be a string/);
  assert.match(issuesOf({ packageName: "a\u0000b" })[0] ?? "", /packageName must be a string without a NUL byte/);
});

test("zeroPadName is an integer from 0 to 64", () => {
  assert.deepEqual(unpackOf({ zeroPadName: 0 }), { zeroPadName: 0 });
  assert.deepEqual(unpackOf({ zeroPadName: 64 }), { zeroPadName: 64 });
  for (const bad of [-1, 65, 1.5, "3", NaN, Infinity, -0]) {
    assert.deepEqual(issuesOf({ zeroPadName: bad }), ["parse-context unpack-config: zeroPadName must be an integer from 0 to 64"], String(bad));
  }
});

test("maxUnpackBytes is 0 or more; -1, Tika's no limit, is refused because the bytes are held in memory", () => {
  assert.deepEqual(unpackOf({ maxUnpackBytes: 0 }), { maxUnpackBytes: 0 });
  assert.match(issuesOf({ maxUnpackBytes: -1 })[0] ?? "", /maxUnpackBytes -1 \(no limit\) is not available/);
  for (const bad of [-2, 1.5, "100", NaN, Infinity, -0]) {
    assert.deepEqual(issuesOf({ maxUnpackBytes: bad }), ["parse-context unpack-config: maxUnpackBytes must be an integer, 0 or more"], String(bad));
  }
});

test("unpack-config must be an object", () => {
  for (const bad of [null, [], "REGULAR", 1]) {
    assert.deepEqual(issuesOf(bad), ["parse-context unpack-config must be an object"], JSON.stringify(bad));
  }
});

test("every bad setting is reported, not only the first", () => {
  assert.equal(issuesOf({ outputFormat: "TAR", zeroPadName: -1, emitter: "x", bogus: 1 }).length, 4);
});

test("an unpack-config with issues sets nothing", () => {
  assert.throws(() => loadConfig({ ...PIPES, "parse-context": { "unpack-config": { outputFormat: "TAR" } } }));
});

test("a configuration with no pipes sections says the unpack-config changes nothing", () => {
  const config = loadConfig({ "parse-context": { "unpack-config": { outputFormat: "REGULAR" } } });
  assert.equal(config.pipes, null);
  assert.ok(config.notices.some((notice) => notice.includes("unpack-config") && notice.includes("no pipes sections")), config.notices.join("\n"));
});

test("unpack-config sits beside the limit blocks without disturbing them", () => {
  const config = loadConfig({
    ...PIPES,
    "parse-context": { "embedded-limits": { maxDepth: 3, throwOnMaxDepth: true }, "unpack-config": { outputMode: "DIRECTORY" } },
  });
  assert.deepEqual(config.limits, { maxNodeDepth: 3 });
  assert.deepEqual(config.pipes?.unpack, { outputMode: "DIRECTORY" });
});

test("parseUnpackConfig returns a copy: the caller's object is not kept", () => {
  const given = { packageRoot: "a" };
  const { settings } = parseUnpackConfig(given);
  assert.notEqual(settings, given);
  assert.deepEqual(settings, given);
});
