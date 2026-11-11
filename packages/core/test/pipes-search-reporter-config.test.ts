import assert from "node:assert/strict";
import { test } from "node:test";
import { PIPES_RESULT_STATUSES } from "../src/pipes-config.ts";
import { parseSearchReporter, type SearchReporterType } from "../src/pipes-search-reporter-config.ts";

/*
 * Tika's es-pipes-reporter and opensearch-pipes-reporter (tika-pipes-es ESReporterConfig, tika-pipes-opensearch
 * OpenSearchReporterConfig 4.2.0) as a configuration gives them (tikajs-68os.34). The rules are those of the two config
 * classes (read from source, not run against a Tika), the strict mapper's refusal of a key a class does not have, and the
 * ripstream way of refusing what node's fetch cannot do, which is that of the Elasticsearch emitter in core.
 */

const URL_ES = "https://es.example:9200/status-index";
const KEY: Record<SearchReporterType, string> = { "es-pipes-reporter": "esUrl", "opensearch-pipes-reporter": "openSearchUrl" };

function read(type: SearchReporterType, config: Record<string, unknown>) {
  const issues: string[] = [];
  const notices: string[] = [];
  const result = parseSearchReporter(type, config, { at: "c", issues, notices, statuses: Object.keys(PIPES_RESULT_STATUSES) });
  return { result, issues, notices };
}
const es = (config: Record<string, unknown> = {}) => read("es-pipes-reporter", { esUrl: URL_ES, ...config });
const opensearch = (config: Record<string, unknown> = {}) => read("opensearch-pipes-reporter", { openSearchUrl: URL_ES, ...config });

test("a reporter with a URL has Tika's defaults: no prefix, no routing, nothing filtered", () => {
  assert.deepEqual(es().result, { type: "es-pipes-reporter", url: URL_ES, keyPrefix: "", includeRouting: false });
  assert.deepEqual(opensearch().result, { type: "opensearch-pipes-reporter", url: URL_ES, keyPrefix: "", includeRouting: false });
  assert.deepEqual(es().issues, []);
  assert.deepEqual(opensearch().issues, []);
});

test("the URL key is esUrl for Elasticsearch and openSearchUrl for OpenSearch, and the other one is refused", () => {
  assert.deepEqual(read("es-pipes-reporter", {}).issues, ["c.esUrl is required and must be the index's URL"]);
  assert.deepEqual(read("opensearch-pipes-reporter", {}).issues, ["c.openSearchUrl is required and must be the index's URL"]);
  const wrong = read("es-pipes-reporter", { openSearchUrl: URL_ES });
  assert.equal(wrong.result, undefined);
  assert.match(wrong.issues.join("\n"), /c\.openSearchUrl is not a setting ripstream has \(it reads esUrl, /);
  assert.deepEqual(read("opensearch-pipes-reporter", { openSearchUrl: URL_ES, esUrl: URL_ES }).issues.length, 1);
});

test("a key that Tika's config class does not have is refused by name, and the API key is Elasticsearch's alone", () => {
  assert.match(es({ commitWithin: 100 }).issues.join("\n"), /c\.commitWithin is not a setting ripstream has/);
  assert.match(opensearch({ apiKey: "k" }).issues.join("\n"), /c\.apiKey is not a setting ripstream has/);
  assert.equal(es({ apiKey: "k" }).result?.apiKey, "k");
  assert.deepEqual(es({ apiKey: 7 }).issues, ["c.apiKey must be a string"]);
});

test("the URL must be http(s) without credentials, a query or a fragment, and loses its trailing slashes", () => {
  for (const type of Object.keys(KEY) as SearchReporterType[]) {
    const key = KEY[type];
    assert.deepEqual(read(type, { [key]: "ftp://x/i" }).issues, [`c.${key} must be an http or https URL`]);
    assert.deepEqual(read(type, { [key]: "not a url" }).issues, [`c.${key} must be an http or https URL`]);
    assert.match(read(type, { [key]: "https://u:p@x/i" }).issues.join(), /must not carry a user name or password/);
    assert.match(read(type, { [key]: "https://x/i?pretty" }).issues.join(), /must not carry a query or a fragment/);
    assert.equal(read(type, { [key]: "https://x/i//" }).result?.url, "https://x/i");
  }
});

test("includes and excludes name result statuses, and one of them at most may have any", () => {
  assert.deepEqual(es({ includes: ["PARSE_SUCCESS", "EMIT_EXCEPTION"] }).result?.includes, ["PARSE_SUCCESS", "EMIT_EXCEPTION"]);
  assert.deepEqual(opensearch({ excludes: ["EMIT_SUCCESS"] }).result?.excludes, ["EMIT_SUCCESS"]);
  assert.equal("includes" in (es({ includes: [] }).result ?? {}), false, "an empty list filters nothing, as in Tika");
  assert.match(es({ includes: ["NOPE"] }).issues.join(), /c\.includes\[0\] "NOPE" is not a result status/);
  assert.match(es({ includes: "PARSE_SUCCESS" }).issues.join(), /c\.includes must be an array of result statuses/);
  const both = es({ includes: ["PARSE_SUCCESS"], excludes: ["EMIT_SUCCESS"] });
  assert.equal(both.result, undefined);
  assert.deepEqual(both.issues, ["c may set includes or excludes, not both: Tika refuses \"Only one of includes and excludes may have any contents\""]);
  assert.deepEqual(es({ includes: ["PARSE_SUCCESS"], excludes: [] }).issues, []);
});

test("keyPrefix goes before the keys the reporter writes, and a prefix in Tika's own namespace is refused", () => {
  assert.equal(es({ keyPrefix: "ripstream_" }).result?.keyPrefix, "ripstream_");
  assert.equal(opensearch({ keyPrefix: null }).result?.keyPrefix, "");
  assert.equal(es({ keyPrefix: "  " }).result?.keyPrefix, "", "a blank prefix is none, as in Tika");
  assert.deepEqual(es({ keyPrefix: 7 }).issues, ["c.keyPrefix must be a string"]);
  for (const type of Object.keys(KEY) as SearchReporterType[]) {
    for (const prefix of ["tk:", "tk:status_", "X-TIKA:"]) {
      const { result, issues } = read(type, { [KEY[type]]: URL_ES, keyPrefix: prefix });
      assert.equal(result, undefined, `${type} ${prefix}`);
      assert.match(issues.join(), /keyPrefix .* is in the reserved Tika-native namespace \(tk:\/X-TIKA:\)/);
    }
    assert.deepEqual(read(type, { [KEY[type]]: URL_ES, keyPrefix: "TK-" }).issues, [], "only the exact prefixes are reserved");
  }
});

test("includeRouting is a boolean", () => {
  assert.equal(es({ includeRouting: true }).result?.includeRouting, true);
  assert.equal(opensearch({ includeRouting: null }).result?.includeRouting, false);
  assert.deepEqual(es({ includeRouting: "true" }).issues, ["c.includeRouting must be a boolean"]);
});

test("httpClientConfig: a user name and password go together, and become the basic credentials", () => {
  const { result, issues } = es({ httpClientConfig: { userName: "elastic", password: "pw", authScheme: "Basic" } });
  assert.deepEqual(issues, []);
  assert.equal(result?.userName, "elastic");
  assert.equal(result?.password, "pw");
  assert.deepEqual(es({ httpClientConfig: { userName: "elastic" } }).issues, ["c.httpClientConfig.userName and password go together"]);
  assert.deepEqual(opensearch({ httpClientConfig: { password: "pw" } }).issues, ["c.httpClientConfig.userName and password go together"]);
  assert.match(es({ httpClientConfig: { colour: 1 } }).issues.join(), /c\.httpClientConfig\.colour is not a setting ripstream has/);
  assert.deepEqual(es({ httpClientConfig: [] }).issues, ["c.httpClientConfig must be an object"]);
});

test("httpClientConfig: Elasticsearch's reporter applies the timeout, and refuses a proxy, another scheme and verifySsl false", () => {
  assert.equal(es({ httpClientConfig: { socketTimeoutMillis: 5000 } }).result?.socketTimeoutMillis, 5000);
  assert.equal("socketTimeoutMillis" in (es({ httpClientConfig: { socketTimeoutMillis: 0 } }).result ?? {}), false);
  assert.deepEqual(es({ httpClientConfig: { socketTimeoutMillis: -1 } }).issues, ["c.httpClientConfig.socketTimeoutMillis must be an integer of 0 or more"]);
  assert.match(es({ httpClientConfig: { connectionTimeoutMillis: 100 } }).notices.join(), /connectionTimeoutMillis bounds connecting alone in Tika/);
  assert.match(es({ httpClientConfig: { userName: "u", password: "p", authScheme: "digest" } }).issues.join(), /authScheme "digest" is not supported/);
  assert.match(es({ httpClientConfig: { proxyHost: "proxy" } }).issues.join(), /proxyHost is not supported/);
  assert.match(es({ httpClientConfig: { proxyPort: 3128 } }).issues.join(), /proxyPort is not supported/);
  assert.match(es({ httpClientConfig: { verifySsl: false } }).issues.join(), /verifySsl false is refused/);
  assert.deepEqual(es({ httpClientConfig: { verifySsl: true } }).issues, []);
  assert.deepEqual(es({ httpClientConfig: { verifySsl: "no" } }).issues, ["c.httpClientConfig.verifySsl must be a boolean"]);
});

test("httpClientConfig: OpenSearch's reporter applies only the credentials and verifySsl in Tika, and says so for the rest", () => {
  const { result, issues, notices } = opensearch({
    httpClientConfig: { userName: "u", password: "p", authScheme: "digest", connectionTimeoutMillis: 100, socketTimeoutMillis: 5000, proxyHost: "proxy", proxyPort: 3128 },
  });
  assert.deepEqual(issues, []);
  // Tika ignores the timeout; a request that is never bounded would hang a run, so ripstream applies the one that is set.
  assert.equal(result?.socketTimeoutMillis, 5000);
  for (const key of ["authScheme", "connectionTimeoutMillis", "socketTimeoutMillis", "proxyHost", "proxyPort"]) {
    assert.ok(
      notices.some((notice) => notice.startsWith(`c.httpClientConfig.${key} `) && notice.includes("Tika's opensearch-pipes-reporter")),
      `a notice for ${key}: ${JSON.stringify(notices)}`,
    );
  }
  assert.match(opensearch({ httpClientConfig: { verifySsl: false } }).issues.join(), /verifySsl false is refused/);
});

test("both an apiKey and a user name, and credentials over plain http, are noticed", () => {
  assert.match(es({ apiKey: "k", httpClientConfig: { userName: "u", password: "p" } }).notices.join(), /apiKey and a userName: the apiKey is sent/);
  assert.match(es({ esUrl: "http://es:9200/i", apiKey: "k" }).notices.join(), /plain http, so the credentials are sent unencrypted/);
  assert.deepEqual(es({ esUrl: "http://es:9200/i" }).notices, []);
});
