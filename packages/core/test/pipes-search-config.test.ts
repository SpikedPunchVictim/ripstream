import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, validateConfig, type SearchEmitterSettings } from "../src/index.ts";

/*
 * Tika's es-emitter and opensearch-emitter (tika-pipes-es and tika-pipes-opensearch 4.2.0), as a configuration gives them
 * (tikajs-68os.6.6). The rules are those of ESEmitterConfig and OpenSearchEmitterConfig and of what their emitters do with
 * each setting, read from the source.
 */

const es = (config: Record<string, unknown>) => ({ emitters: { e: { "es-emitter": config } } });
const opensearch = (config: Record<string, unknown>) => ({ emitters: { e: { "opensearch-emitter": config } } });
const MINIMUM = { esUrl: "https://localhost:9200/docs", idField: "id" };
const issues = (config: unknown): string[] => validateConfig(config);
const settingsOf = (config: unknown): SearchEmitterSettings => loadConfig(config).pipes?.emitters[0] as SearchEmitterSettings;

test("the minimum is the index's URL and an idField; updateStrategy is UPSERT then, as Tika's missing one is", () => {
  assert.deepEqual(settingsOf(es(MINIMUM)), { id: "e", type: "es-emitter", url: "https://localhost:9200/docs", updateStrategy: "UPSERT", embeddedFileFieldName: "embedded" });
});

test("every setting ripstream applies is read, for each of the two", () => {
  const common = { idField: "id", attachmentStrategy: "PARENT_CHILD", updateStrategy: "OVERWRITE", embeddedFileFieldName: "attachment", httpClientConfig: { userName: "u", password: "p", authScheme: "basic", socketTimeoutMillis: 5000 } };
  assert.deepEqual(settingsOf(es({ esUrl: "https://h/i", apiKey: "KEY", ...common })), {
    id: "e",
    type: "es-emitter",
    url: "https://h/i",
    attachmentStrategy: "PARENT_CHILD",
    updateStrategy: "OVERWRITE",
    embeddedFileFieldName: "attachment",
    apiKey: "KEY",
    userName: "u",
    password: "p",
    socketTimeoutMillis: 5000,
  });
  assert.deepEqual(settingsOf(opensearch({ openSearchUrl: "https://h/i", ...common })), {
    id: "e",
    type: "opensearch-emitter",
    url: "https://h/i",
    attachmentStrategy: "PARENT_CHILD",
    updateStrategy: "OVERWRITE",
    embeddedFileFieldName: "attachment",
    userName: "u",
    password: "p",
    socketTimeoutMillis: 5000,
  });
});

test("the URL is required, and each type reads its own key", () => {
  assert.deepEqual(issues(es({ idField: "id" })), ["emitters.e.es-emitter.esUrl is required and must be the index's URL"]);
  assert.deepEqual(issues(opensearch({ idField: "id" })), ["emitters.e.opensearch-emitter.openSearchUrl is required and must be the index's URL"]);
  assert.match(issues(opensearch({ esUrl: "http://h/i", idField: "id" }))[0] ?? "", /opensearch-emitter\.esUrl is not a setting ripstream has \(it reads openSearchUrl/);
});

test("idField is required as Tika's validation requires it, and said to change nothing", () => {
  assert.deepEqual(issues(es({ esUrl: "http://h/i" })), ["emitters.e.es-emitter.idField is required and must be a non-empty string"]);
  const config = loadConfig(es(MINIMUM));
  assert.ok(config.notices.some((notice) => notice.includes("idField") && notice.includes("emit key")));
});

test("the URL is http or https, carries no credentials, query or fragment, and loses a trailing slash", () => {
  assert.match(issues(es({ ...MINIMUM, esUrl: "ftp://h/i" }))[0] ?? "", /must be an http or https URL/);
  assert.match(issues(es({ ...MINIMUM, esUrl: "not a url" }))[0] ?? "", /must be an http or https URL/);
  assert.match(issues(es({ ...MINIMUM, esUrl: "https://user:pass@h/i" }))[0] ?? "", /must not carry a user name or password/);
  assert.match(issues(es({ ...MINIMUM, esUrl: "https://h/i?refresh=true" }))[0] ?? "", /must not carry a query or a fragment/);
  assert.equal(settingsOf(es({ ...MINIMUM, esUrl: "https://h/i/" })).url, "https://h/i");
});

test("a secret is never in a message", () => {
  const messages = issues(es({ esUrl: "https://user:SECRETPASS@h/i", idField: "id", apiKey: 5, httpClientConfig: { userName: "u", password: "SECRETPASS", authScheme: "ntlm" } })).join("\n");
  assert.ok(messages.length > 0);
  assert.ok(!messages.includes("SECRETPASS"));
});

test("the enums are Tika's, and an unknown one is named with the choices", () => {
  assert.deepEqual(issues(es({ ...MINIMUM, attachmentStrategy: "NESTED" })), ["emitters.e.es-emitter.attachmentStrategy must be SEPARATE_DOCUMENTS or PARENT_CHILD"]);
  assert.deepEqual(issues(es({ ...MINIMUM, updateStrategy: "MERGE" })), ["emitters.e.es-emitter.updateStrategy must be OVERWRITE or UPSERT"]);
  assert.deepEqual(issues(es({ ...MINIMUM, chunkStrategy: "SPLIT" })), ["emitters.e.es-emitter.chunkStrategy must be INLINE or DOCUMENTS"]);
});

test("chunkStrategy DOCUMENTS is refused: ripstream makes no tk:chunks to split; INLINE is read", () => {
  assert.match(issues(es({ ...MINIMUM, chunkStrategy: "DOCUMENTS" }))[0] ?? "", /chunkStrategy DOCUMENTS .*ripstream produces no tk:chunks/);
  assert.deepEqual(issues(es({ ...MINIMUM, chunkStrategy: "INLINE" })), []);
  // Tika's own validate() would refuse this pair; here the first reason is the one that matters.
  assert.ok(issues(es({ ...MINIMUM, chunkStrategy: "DOCUMENTS", attachmentStrategy: "PARENT_CHILD" })).some((message) => message.includes("chunk documents have no join field")));
});

test("the API key is Elasticsearch's alone", () => {
  assert.match(issues(opensearch({ openSearchUrl: "http://h/i", idField: "id", apiKey: "k" }))[0] ?? "", /opensearch-emitter\.apiKey is not a setting ripstream has/);
});

test("userName and password go together, and the only scheme is basic", () => {
  assert.deepEqual(issues(es({ ...MINIMUM, httpClientConfig: { userName: "u" } })), ["emitters.e.es-emitter.httpClientConfig.userName and password go together"]);
  assert.match(issues(es({ ...MINIMUM, httpClientConfig: { userName: "u", password: "p", authScheme: "ntlm" } }))[0] ?? "", /authScheme "ntlm" is not supported: ripstream sends basic authentication/);
  assert.deepEqual(issues(es({ ...MINIMUM, httpClientConfig: { userName: "u", password: "p", authScheme: "Basic" } })), []);
});

test("a proxy and verifySsl false are refused with where to go instead; verifySsl true is the default", () => {
  assert.match(issues(es({ ...MINIMUM, httpClientConfig: { proxyHost: "p", proxyPort: 3128 } })).join("\n"), /proxyHost is not supported[\s\S]*proxyPort is not supported/);
  assert.match(issues(es({ ...MINIMUM, httpClientConfig: { verifySsl: false } }))[0] ?? "", /verifySsl false is refused.*NODE_EXTRA_CA_CERTS/);
  assert.deepEqual(issues(es({ ...MINIMUM, httpClientConfig: { verifySsl: true } })), []);
});

test("settings that change nothing are accepted and said so; credentials over plain http are called out", () => {
  const config = loadConfig(es({ esUrl: "http://h/i", idField: "id", commitWithin: 100, apiKey: "k", httpClientConfig: { connectionTimeoutMillis: 3000 } }));
  assert.ok(config.notices.some((notice) => notice.includes("commitWithin") && notice.includes("not used")));
  assert.ok(config.notices.some((notice) => notice.includes("connectionTimeoutMillis") && notice.includes("socketTimeoutMillis")));
  assert.ok(config.notices.some((notice) => notice.includes("plain http") && notice.includes("unencrypted")));
  const both = loadConfig(es({ ...MINIMUM, apiKey: "k", httpClientConfig: { userName: "u", password: "p" } }));
  assert.ok(both.notices.some((notice) => notice.includes("the apiKey is sent")));
  assert.equal(settingsOf(es({ ...MINIMUM, apiKey: "k", httpClientConfig: { userName: "u", password: "p" } })).apiKey, "k");
});

test("an unknown key is named, in the emitter and in httpClientConfig", () => {
  assert.match(issues(es({ ...MINIMUM, bogus: 1 }))[0] ?? "", /es-emitter\.bogus is not a setting ripstream has/);
  assert.match(issues(es({ ...MINIMUM, httpClientConfig: { bogus: 1 } }))[0] ?? "", /httpClientConfig\.bogus is not a setting ripstream has/);
});

test("components ripstream still lacks are named with what it has", () => {
  const messages = issues({ emitters: { s: { "solr-emitter": { solrCollection: "c" } } } });
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /solr-emitter is not an emitter ripstream has: .*Elasticsearch and OpenSearch emitters/);
});
