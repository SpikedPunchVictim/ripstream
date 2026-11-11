import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, validateConfig, type PipesReporterSettings, type PipesSettings } from "../src/index.ts";

/*
 * The GCS, Azure Blob and Solr components and the Elasticsearch and OpenSearch reporters of a Tika configuration
 * (tikajs-68os.31 to .34), as `loadConfig` reads them. Each component's own rules are tested with its parser
 * (pipes-gcs-config.test.ts and the others); this tests that the pipes sections know them, and what they still refuse.
 */

const GCS = { projectId: "p", bucket: "b" };
const AZURE = { sasToken: "sv=2022-11-02&sig=abc", endpoint: "https://acct.blob.core.windows.net", container: "docs" };
const SOLR = { solrCollection: "docs", solrUrls: ["http://localhost:8983/solr"] };
const SOLR_ITERATOR = { ...SOLR, idField: "path", parsingIdField: "parsing_id", failCountField: "fail_count", sizeFieldName: "size" };
const pipes = (config: unknown): PipesSettings => loadConfig(config).pipes as PipesSettings;

/** The iterator, fetcher and emitter that a component's three types make together. */
function triple(prefix: string, fetcher: object, emitter: object, iterator: object): object {
  return {
    fetchers: { f: { [`${prefix}-fetcher`]: fetcher } },
    emitters: { e: { [`${prefix}-emitter`]: emitter } },
    "pipes-iterator": { [`${prefix}-pipes-iterator`]: { ...iterator, fetcherId: "f", emitterId: "e" } },
  };
}

test("a fetcher, emitter and iterator of GCS, Azure Blob and Solr load as settings of their types", () => {
  const gcs = pipes(triple("gcs", GCS, GCS, GCS));
  assert.deepEqual([gcs.fetchers[0]?.type, gcs.emitters[0]?.type, gcs.iterator?.type], ["gcs-fetcher", "gcs-emitter", "gcs-pipes-iterator"]);
  const azure = pipes(triple("az-blob", AZURE, AZURE, AZURE));
  assert.deepEqual([azure.fetchers[0]?.type, azure.emitters[0]?.type, azure.iterator?.type], ["az-blob-fetcher", "az-blob-emitter", "az-blob-pipes-iterator"]);
  const solr = loadConfig({ emitters: { e: { "solr-emitter": SOLR } }, "pipes-iterator": { "solr-pipes-iterator": { ...SOLR_ITERATOR, fetcherId: "f", emitterId: "e" } }, fetchers: { f: { "http-fetcher": {} } } }).pipes as PipesSettings;
  assert.deepEqual([solr.emitters[0]?.type, solr.iterator?.type], ["solr-emitter", "solr-pipes-iterator"]);
});

test("the settings carry what the configuration said, under the id it was given", () => {
  const settings = pipes(triple("gcs", GCS, { ...GCS, prefix: "out/", fileExtension: "json" }, { ...GCS, prefix: "in/" }));
  assert.deepEqual(settings.fetchers[0], { id: "f", type: "gcs-fetcher", gcs: GCS });
  assert.deepEqual(settings.emitters[0], { id: "e", type: "gcs-emitter", gcs: GCS, prefix: "out", fileExtension: "json" });
  assert.deepEqual(settings.iterator, { type: "gcs-pipes-iterator", gcs: GCS, prefix: "in/", fetcherId: "f", emitterId: "e" });
});

test("an error in one of them is named by its place in the configuration", () => {
  assert.ok(validateConfig(triple("gcs", { bucket: "b" }, GCS, GCS)).includes("fetchers.f.gcs-fetcher.projectId is required and must be a non-empty string"));
  assert.match(validateConfig(triple("az-blob", AZURE, { ...AZURE, bogus: 1 }, AZURE)).join("\n"), /emitters\.e\.az-blob-emitter\.bogus is not a setting ripstream has/);
  assert.match(validateConfig({ emitters: { e: { "solr-emitter": { solrCollection: "docs" } } } }).join("\n"), /emitters\.e\.solr-emitter\.solrUrls is required/);
});

test("what a component accepts and changes nothing of reaches the notices of the settings", () => {
  const notices = pipes(triple("gcs", GCS, GCS, GCS)).notices.join("\n");
  assert.match(notices, /fetchers\.f\.gcs-fetcher\.projectId is required by Tika/);
});

test("an Elasticsearch and an OpenSearch reporter load beside the jsonl one, in the order the configuration gives them", () => {
  const settings = pipes({
    "pipes-reporters": {
      "file-system-jsonl-reporter": { path: "/tmp/report.jsonl", onExists: "APPEND" },
      "es-pipes-reporter": { esUrl: "https://es.example/status", includes: ["EMIT_EXCEPTION"], keyPrefix: "rs_", includeRouting: true },
      "opensearch-pipes-reporter": { openSearchUrl: "https://os.example/status", excludes: ["EMIT_SUCCESS"], httpClientConfig: { userName: "u", password: "p" } },
    },
  });
  assert.deepEqual(
    settings.reporters.map((reporter: PipesReporterSettings) => reporter.type),
    ["file-system-jsonl-reporter", "es-pipes-reporter", "opensearch-pipes-reporter"],
  );
  assert.deepEqual(settings.reporters[1], { type: "es-pipes-reporter", url: "https://es.example/status", includes: ["EMIT_EXCEPTION"], keyPrefix: "rs_", includeRouting: true });
  assert.deepEqual(settings.reporters[2], { type: "opensearch-pipes-reporter", url: "https://os.example/status", excludes: ["EMIT_SUCCESS"], keyPrefix: "", includeRouting: false, userName: "u", password: "p" });
});

test("a reporter's statuses are checked against Tika's, and an error is named by its place", () => {
  const messages = validateConfig({ "pipes-reporters": { "es-pipes-reporter": { esUrl: "https://es.example/status", includes: ["EMIT_EXCEPTION", "NOPE"], excludes: ["EMIT_SUCCESS"] } } });
  assert.match(messages.join("\n"), /pipes-reporters\.es-pipes-reporter\.includes\[1\] "NOPE" is not a result status \(Tika's are FAILED_TO_INITIALIZE, /);
  assert.match(messages.join("\n"), /pipes-reporters\.es-pipes-reporter may set includes or excludes, not both/);
  assert.deepEqual(validateConfig({ "pipes-reporters": { "es-pipes-reporter": {} } }), ["pipes-reporters.es-pipes-reporter.esUrl is required and must be the index's URL"]);
  assert.deepEqual(validateConfig({ "pipes-reporters": { "es-pipes-reporter": 7 } }), ["pipes-reporters.es-pipes-reporter must be an object"]);
});

test("the jsonl reporter is read as before", () => {
  const [reporter] = pipes({ "pipes-reporters": { "file-system-jsonl-reporter": { path: "/tmp/r.jsonl" } } }).reporters;
  assert.deepEqual(reporter, { type: "file-system-jsonl-reporter", path: "/tmp/r.jsonl", onExists: "EXCEPTION", maxMessageLength: 10000 });
});

test("what ripstream still lacks is refused by name, and the message names exactly that", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["fetchers", { x: { "google-drive-fetcher": {} } }, /fetchers\.x\.google-drive-fetcher is not a fetcher ripstream has/],
    ["fetchers", { x: { "microsoft-graph-fetcher": {} } }, /fetchers\.x\.microsoft-graph-fetcher is not a fetcher ripstream has/],
    ["fetchers", { x: { "atlassian-jwt-fetcher": {} } }, /fetchers\.x\.atlassian-jwt-fetcher is not a fetcher ripstream has/],
    ["emitters", { x: { "kafka-emitter": {} } }, /emitters\.x\.kafka-emitter is not an emitter ripstream has/],
    ["emitters", { x: { "jdbc-emitter": {} } }, /emitters\.x\.jdbc-emitter is not an emitter ripstream has/],
    ["pipes-iterator", { "csv-pipes-iterator": {} }, /pipes-iterator\.csv-pipes-iterator is not an iterator ripstream has/],
    ["pipes-iterator", { "kafka-pipes-iterator": {} }, /pipes-iterator\.kafka-pipes-iterator is not an iterator ripstream has/],
    ["pipes-reporters", { "jdbc-reporter": {} }, /pipes-reporters\.jdbc-reporter is not a reporter ripstream has/],
  ];
  for (const [section, value, pattern] of cases) {
    const messages = validateConfig({ [section]: value });
    assert.match(messages.join("\n"), pattern, section);
    const message = messages.find((candidate) => pattern.test(candidate)) ?? "";
    assert.match(message, /Not implemented: the jdbc and kafka components, the atlassian-jwt, google-drive and microsoft-graph fetchers, and the csv and json iterators/);
    for (const have of ["GCS", "Azure Blob", "Solr", "Elasticsearch", "OpenSearch"]) assert.ok(message.includes(have), `the message says ripstream has ${have}`);
  }
});

test("the types ripstream now has are no longer refused as missing", () => {
  for (const [section, value] of [
    ["fetchers", { x: { "gcs-fetcher": GCS } }],
    ["fetchers", { x: { "az-blob-fetcher": AZURE } }],
    ["emitters", { x: { "solr-emitter": SOLR } }],
    ["pipes-reporters", { "opensearch-pipes-reporter": { openSearchUrl: "https://os.example/status" } }],
  ] as const) {
    assert.ok(!validateConfig({ [section]: value }).some((message) => message.includes("ripstream has:")), section);
  }
});
