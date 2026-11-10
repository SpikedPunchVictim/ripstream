import assert from "node:assert/strict";
import { test } from "node:test";
import { RipstreamConfigError, loadConfig, validateConfig } from "../src/index.ts";

/*
 * The pipes sections of a Tika configuration (tikajs-68os.6.2): what ripstream has loads, what changes nothing loads
 * with a notice, and the rest is refused by name with the reason.
 */

const fsPipeline = {
  fetchers: { fsf: { "file-system-fetcher": { basePath: "/in", extractFileSystemMetadata: false } } },
  emitters: { fse: { "file-system-emitter": { basePath: "/out" } } },
  "pipes-iterator": { "file-system-pipes-iterator": { basePath: "/in", fetcherId: "fsf", emitterId: "fse" } },
  pipes: { parseMode: "RMETA", onParseException: "EMIT", numClients: 2, queueSize: 50 },
};

const issuesOf = (config: unknown): string[] => validateConfig(config);

test("a Tika file-system pipeline loads, with the keys that map applied", () => {
  const config = loadConfig(fsPipeline);
  assert.deepEqual(config.pipes?.fetchers, [{ id: "fsf", type: "file-system-fetcher", basePath: "/in", allowAbsolutePaths: false }]);
  assert.equal(config.pipes?.emitters[0]?.basePath, "/out");
  assert.deepEqual(config.pipes?.iterator, { type: "file-system-pipes-iterator", basePath: "/in", fetcherId: "fsf", emitterId: "fse" });
  assert.equal(config.pipes?.parseMode, "RMETA");
  assert.equal(config.pipes?.onParseException, "EMIT");
  assert.equal(config.pipes?.concurrency, 2);
  assert.equal(config.pipes?.maxQueue, 50);
  assert.deepEqual(config.notices, []);
});

test("a configuration with no pipes sections has no pipes settings", () => {
  assert.equal(loadConfig({ version: 1 }).pipes, null);
});

test("the pipes sections load next to the sections ripstream already applies", () => {
  const config = loadConfig({ ...fsPipeline, "parse-context": { "output-limits": { writeLimit: 1000, throwOnWriteLimit: true } }, server: { port: 9000 } });
  assert.equal(config.server?.port, 9000);
  assert.equal(config.pipes?.concurrency, 2);
});

test("parseMode is read in any case, as Tika's ParseMode.parse does", () => {
  assert.equal(loadConfig({ ...fsPipeline, pipes: { parseMode: "concatenate" } }).pipes?.parseMode, "CONCATENATE");
  assert.match(issuesOf({ ...fsPipeline, pipes: { parseMode: "TEXT" } }).join("\n"), /pipes\.parseMode must be one of RMETA, CONCATENATE/);
});

test("plugin-roots, JVM process knobs and emit batching are accepted and say they change nothing", () => {
  const config = loadConfig({
    ...fsPipeline,
    "plugin-roots": "/plugins",
    pipes: {
      forkedJvmArgs: ["-Xmx512m"],
      javaPath: "java",
      emitStrategy: { type: "DYNAMIC", thresholdBytes: 1000000 },
      emitWithinMillis: 10000,
      numEmitters: 2,
      emitIntermediateResults: false,
    },
  });
  const text = config.notices.join("\n");
  for (const name of ["plugin-roots", "pipes.forkedJvmArgs", "pipes.javaPath", "pipes.emitStrategy", "pipes.emitWithinMillis", "pipes.numEmitters"]) {
    assert.ok(text.includes(name), `a notice names ${name}`);
  }
  assert.equal(config.notices.length, 6);
  assert.equal(config.pipes?.concurrency, undefined, "an accepted setting applies nothing");
});

test("a switch that opens a feature ripstream lacks is accepted off and refused on", () => {
  assert.deepEqual(issuesOf({ ...fsPipeline, pipes: { emitIntermediateResults: false } }), []);
  assert.match(issuesOf({ ...fsPipeline, pipes: { emitIntermediateResults: true } }).join("\n"), /emitIntermediateResults is true/);
  assert.match(issuesOf({ ...fsPipeline, pipes: { emitStrategy: { type: "PASSBACK_ALL" } } }).join("\n"), /PASSBACK_ALL/);
  const fetchers = { fsf: { "file-system-fetcher": { basePath: "/in", extractFileSystemMetadata: true } } };
  assert.match(issuesOf({ ...fsPipeline, fetchers }).join("\n"), /extractFileSystemMetadata is true/);
});

test("pipes keys with no counterpart are refused by name", () => {
  const issues = issuesOf({ ...fsPipeline, pipes: { maxFilesProcessedPerProcess: 100, configStoreType: "ignite", bogus: 1 } }).join("\n");
  assert.match(issues, /pipes\.maxFilesProcessedPerProcess restarts Tika's forked server/);
  assert.match(issues, /pipes\.configStoreType/);
  assert.match(issues, /pipes\.bogus is not a setting ripstream has/);
});

test("a component ripstream does not have is refused by name, with where the cloud ones are tracked", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["fetchers", { gcs: { "gcs-fetcher": { bucket: "b" } } }, /fetchers\.gcs\.gcs-fetcher is not a fetcher ripstream has.*docs\/migration\.md/],
    ["emitters", { solr: { "solr-emitter": {} } }, /emitters\.solr\.solr-emitter is not an emitter ripstream has/],
    ["pipes-iterator", { "jdbc-pipes-iterator": {} }, /pipes-iterator\.jdbc-pipes-iterator is not an iterator ripstream has/],
    ["pipes-reporters", { "jdbc-reporter": {} }, /pipes-reporters\.jdbc-reporter is not a reporter ripstream has/],
  ];
  for (const [section, value, pattern] of cases) {
    assert.match(issuesOf({ [section]: value }).join("\n"), pattern, section);
  }
});

test("a component takes exactly one type, and ids follow Tika's rules", () => {
  assert.match(issuesOf({ fetchers: { fsf: {} } }).join("\n"), /fetchers\.fsf must name exactly one component type, got none/);
  assert.match(
    issuesOf({ fetchers: { fsf: { "file-system-fetcher": { basePath: "/a" }, "http-fetcher": {} } } }).join("\n"),
    /must name exactly one component type/,
  );
  assert.match(issuesOf({ fetchers: { "bad id": { "http-fetcher": {} } } }).join("\n"), /id "bad id" may only use/);
  assert.match(issuesOf({ fetchers: { __inline: { "http-fetcher": {} } } }).join("\n"), /starts with "__"/);
});

test("file-system-fetcher needs basePath or allowAbsolutePaths, and only reads local files", () => {
  assert.match(issuesOf({ fetchers: { f: { "file-system-fetcher": {} } } }).join("\n"), /needs basePath, or allowAbsolutePaths true/);
  assert.deepEqual(issuesOf({ fetchers: { f: { "file-system-fetcher": { allowAbsolutePaths: true } } } }), []);
  assert.match(issuesOf({ fetchers: { f: { "file-system-fetcher": { basePath: "s3://bucket" } } } }).join("\n"), /not a local directory/);
  assert.match(issuesOf({ fetchers: { f: { "file-system-fetcher": { basePath: "/a", mystery: 1 } } } }).join("\n"), /file-system-fetcher\.mystery is not a setting/);
});

test("http-fetcher takes no settings: each one given is refused by name", () => {
  assert.deepEqual(issuesOf({ fetchers: { h: { "http-fetcher": {} } } }), []);
  assert.match(issuesOf({ fetchers: { h: { "http-fetcher": { userAgent: "x", maxRedirects: 3 } } } }).join("\n"), /http-fetcher\.userAgent is not supported.*http-fetcher\.maxRedirects/s);
});

test("file-system-emitter: Tika's defaults hold for what the configuration leaves out", () => {
  const [emitter] = loadConfig({ ...fsPipeline }).pipes!.emitters;
  assert.deepEqual(emitter, {
    id: "fse",
    type: "file-system-emitter",
    basePath: "/out",
    allowAbsolutePaths: false,
    onExists: "EXCEPTION",
    atomicWrites: true,
    compression: "NONE",
    prettyPrint: false,
  });
});

test("file-system-emitter: every setting Tika's emitter has is read", () => {
  const config = loadConfig({
    ...fsPipeline,
    emitters: {
      fse: {
        "file-system-emitter": {
          basePath: "/out",
          fileExtension: "json",
          onExists: "SKIP",
          atomicWrites: false,
          compression: "GZIP",
          prettyPrint: true,
        },
      },
    },
  });
  assert.deepEqual(config.pipes?.emitters, [
    {
      id: "fse",
      type: "file-system-emitter",
      basePath: "/out",
      fileExtension: "json",
      allowAbsolutePaths: false,
      onExists: "SKIP",
      atomicWrites: false,
      compression: "GZIP",
      prettyPrint: true,
    },
  ]);
});

test("file-system-emitter needs basePath or allowAbsolutePaths, as Tika's checkConfig does", () => {
  assert.match(issuesOf({ emitters: { e: { "file-system-emitter": {} } } }).join("\n"), /file-system-emitter needs basePath, or allowAbsolutePaths true/);
  const open = loadConfig({ ...fsPipeline, emitters: { fse: { "file-system-emitter": { allowAbsolutePaths: true } } } });
  assert.deepEqual(open.pipes?.emitters[0]?.allowAbsolutePaths, true);
  assert.equal(open.pipes?.emitters[0]?.basePath, undefined);
});

test("file-system-emitter values that Tika's enums and types refuse are refused by name", () => {
  const bad = (config: Record<string, unknown>): string =>
    issuesOf({ emitters: { e: { "file-system-emitter": { basePath: "/o", ...config } } } }).join("\n");
  assert.match(bad({ onExists: "skip" }), /file-system-emitter\.onExists must be EXCEPTION, SKIP or REPLACE/);
  assert.match(bad({ onExists: "APPEND" }), /onExists must be EXCEPTION, SKIP or REPLACE/);
  assert.match(bad({ compression: "ZIP" }), /file-system-emitter\.compression must be NONE or GZIP/);
  assert.match(bad({ atomicWrites: "yes" }), /file-system-emitter\.atomicWrites must be a boolean/);
  assert.match(bad({ prettyPrint: 1 }), /file-system-emitter\.prettyPrint must be a boolean/);
  assert.match(bad({ allowAbsolutePaths: "true" }), /file-system-emitter\.allowAbsolutePaths must be a boolean/);
  assert.match(bad({ fileExtension: 7 }), /file-system-emitter\.fileExtension must be a string/);
  assert.match(bad({ fileExtension: "a/b" }), /fileExtension must not contain a path separator/);
  assert.match(bad({ basePath: "" }), /basePath must be a non-empty string/);
  assert.match(bad({ nope: 1 }), /file-system-emitter\.nope is not a setting ripstream has/);
});

test("the iterator names a fetcher and an emitter that exist", () => {
  const issues = issuesOf({ ...fsPipeline, "pipes-iterator": { "file-system-pipes-iterator": { basePath: "/in", fetcherId: "nope", emitterId: "also-nope" } } }).join("\n");
  assert.match(issues, /fetcherId "nope" is not in fetchers/);
  assert.match(issues, /emitterId "also-nope" is not in emitters/);
  assert.match(issuesOf({ ...fsPipeline, "pipes-iterator": { "file-system-pipes-iterator": { basePath: "/in" } } }).join("\n"), /fetcherId is required/);
});

test("countTotal is accepted and says it changes nothing", () => {
  const config = loadConfig({ ...fsPipeline, "pipes-iterator": { "file-system-pipes-iterator": { basePath: "/in", countTotal: true, fetcherId: "fsf", emitterId: "fse" } } });
  assert.match(config.notices.join("\n"), /countTotal/);
});

test("file-system-jsonl-reporter: Tika's defaults, the status filter and its limits", () => {
  const config = loadConfig({ "pipes-reporters": { "file-system-jsonl-reporter": { path: "/r.jsonl", includes: ["TIMEOUT", "FETCH_EXCEPTION"] } } });
  assert.deepEqual(config.pipes?.reporters, [
    { type: "file-system-jsonl-reporter", path: "/r.jsonl", includes: ["TIMEOUT", "FETCH_EXCEPTION"], onExists: "EXCEPTION", maxMessageLength: 10_000 },
  ]);
  const issues = (reporter: unknown): string => issuesOf({ "pipes-reporters": { "file-system-jsonl-reporter": reporter } }).join("\n");
  assert.match(issues({ path: "/r", includes: ["TIMEOUT"], excludes: ["OOM"] }), /includes or excludes, not both/);
  assert.match(issues({ path: "/r", includes: ["NOT_A_STATUS"] }), /"NOT_A_STATUS" is not a result status/);
  assert.match(issues({ path: "/r", onExists: "SKIP" }), /onExists must be EXCEPTION, APPEND or REPLACE/);
  assert.match(issues({ path: "/r", maxMessageLength: -1 }), /maxMessageLength must be a whole number/);
  assert.match(issues({}), /path is required/);
});

test("plugin-roots must be a string", () => {
  assert.match(issuesOf({ "plugin-roots": ["/a"] }).join("\n"), /"plugin-roots" must be a string/);
});

test("every issue is reported at once, and nothing loads", () => {
  assert.throws(
    () => loadConfig({ fetchers: { gcs: { "gcs-fetcher": {} } }, pipes: { parseMode: "TEXT", bogus: true } }),
    (error: unknown) => error instanceof RipstreamConfigError && error.issues.length === 3,
  );
});

test("a section that is not an object is refused", () => {
  for (const section of ["fetchers", "emitters", "pipes", "pipes-reporters"]) {
    assert.match(issuesOf({ [section]: [] }).join("\n"), new RegExp(`${section} must be an object`));
  }
  assert.match(issuesOf({ "pipes-iterator": "x" }).join("\n"), /pipes-iterator must be an object/);
});
