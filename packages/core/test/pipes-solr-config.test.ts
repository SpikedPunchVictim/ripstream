import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSolrEmitter, parseSolrIterator } from "../src/pipes-solr-config.ts";

/*
 * Tika's solr-emitter and solr-pipes-iterator (tika-pipes-solr 4.2.0), as a configuration gives them (tikajs-68os.33).
 * The rules are those of SolrEmitterConfig.validate() and SolrPipesIterator.configure(), SolrClientHelper's checks of
 * authentication, and the strict mapper's refusal of a key the config classes do not have. The ripstream way of
 * refusing what node's fetch cannot do (a proxy, switching certificate checks off) is that of the Elasticsearch emitter.
 */

const URL_A = "http://localhost:8983/solr";
const BASE = { solrCollection: "docs", solrUrls: [URL_A] };
const ITERATOR = { ...BASE, idField: "path", parsingIdField: "parsing_id", failCountField: "fail_count", sizeFieldName: "size", fetcherId: "f", emitterId: "e" };

function read<T>(parse: (context: { at: string; issues: string[]; notices: string[] }) => T): { result: T; issues: string[]; notices: string[] } {
  const issues: string[] = [];
  const notices: string[] = [];
  return { result: parse({ at: "c", issues, notices }), issues, notices };
}
const emitter = (config: Record<string, unknown>) => read((context) => parseSolrEmitter("e", { ...BASE, ...config }, context));
const iterator = (config: Record<string, unknown>) => read((context) => parseSolrIterator({ ...ITERATOR, ...config }, context));

test("an emitter with a collection and solrUrls has Tika's defaults", () => {
  assert.deepEqual(emitter({}).result, {
    id: "e",
    type: "solr-emitter",
    solr: { urls: [URL_A], collection: "docs", socketTimeoutMillis: 60000 },
    idField: "id",
    commitWithin: 1000,
    attachmentStrategy: "PARENT_CHILD",
    updateStrategy: "ADD",
    embeddedFileFieldName: "embedded",
  });
  assert.deepEqual(emitter({}).issues, []);
});

test("an emitter needs a collection and either solrUrls or solrZkHosts, and not both, as validate() says", () => {
  assert.deepEqual(read((context) => parseSolrEmitter("e", {}, context)).issues, [
    "c.solrCollection is required and must be a non-empty string",
    "c.solrUrls is required: Tika's validate() wants either solrUrls or solrZkHosts",
  ]);
  assert.deepEqual(emitter({ solrCollection: " " }).issues, ["c.solrCollection is required and must be a non-empty string"]);
  assert.deepEqual(emitter({ solrZkHosts: ["zk:2181"] }).issues, ["c has both solrUrls and solrZkHosts: Tika accepts only one of them"]);
});

test("solrZkHosts is refused with the reason: SolrCloud through ZooKeeper needs a ZooKeeper client", () => {
  const { result, issues } = read((context) => parseSolrEmitter("e", { solrCollection: "docs", solrZkHosts: ["zk1:2181", "zk2:2181"], solrZkChroot: "/solr" }, context));
  assert.equal(result, undefined);
  assert.equal(issues.length, 1);
  assert.match(issues[0] ?? "", /^c\.solrZkHosts is not supported: .*ZooKeeper client.*solrUrls/);
  assert.equal(emitter({ solrZkChroot: "/solr" }).notices.filter((notice) => notice.startsWith("c.solrZkChroot")).length, 1, "a chroot beside solrUrls changes nothing and says so");
});

test("solrUrls is a non-empty array of http or https URLs with no credentials, query or fragment", () => {
  assert.deepEqual(emitter({ solrUrls: [URL_A, "https://solr2.example.com:8985/solr/"] }).result?.solr.urls, [URL_A, "https://solr2.example.com:8985/solr"]);
  assert.deepEqual(emitter({ solrUrls: [] }).issues, ["c.solrUrls is required: Tika's validate() wants either solrUrls or solrZkHosts"]);
  assert.deepEqual(emitter({ solrUrls: "http://x" }).issues, ["c.solrUrls must be an array of http or https URLs"]);
  for (const bad of ["localhost:8983/solr", "ftp://x/solr", "http://u:p@x/solr", "http://x/solr?a=1", "http://x/solr#f", 3]) {
    assert.deepEqual(emitter({ solrUrls: [URL_A, bad] }).issues, ["c.solrUrls[1] must be an http or https URL with no credentials, query or fragment"], String(bad));
  }
});

test("a key the config classes do not have is refused, with the list of those it reads", () => {
  assert.deepEqual(emitter({ collection: "x" }).issues, [
    "c.collection is not a setting ripstream has (it reads solrCollection, solrUrls, solrZkHosts, solrZkChroot, idField, commitWithin, connectionTimeoutMillis, socketTimeoutMillis, attachmentStrategy, updateStrategy, embeddedFileFieldName, userName, password, authScheme, proxyHost, proxyPort, verifySsl)",
  ]);
  assert.match(iterator({ commitWithin: 5 }).issues[0] ?? "", /^c\.commitWithin is not a setting ripstream has \(it reads solrCollection, solrUrls, solrZkHosts, solrZkChroot, filters, idField, parsingIdField, failCountField, sizeFieldName, additionalFields, rows, connectionTimeoutMillis, socketTimeoutMillis, userName, password, authScheme, proxyHost, proxyPort, verifySsl, fetcherId, emitterId\)$/);
});

test("the strategies are read in any case, as Tika's toUpperCase does, and a name that is not one is refused", () => {
  assert.equal(emitter({ attachmentStrategy: "separate_documents" }).result?.attachmentStrategy, "SEPARATE_DOCUMENTS");
  assert.equal(emitter({ updateStrategy: "Update_Must_Exist" }).result?.updateStrategy, "UPDATE_MUST_EXIST");
  assert.equal(emitter({ updateStrategy: "UPDATE_MUST_NOT_EXIST" }).result?.updateStrategy, "UPDATE_MUST_NOT_EXIST");
  assert.deepEqual(emitter({ attachmentStrategy: "NESTED", updateStrategy: "REPLACE" }).issues, [
    "c.attachmentStrategy must be SEPARATE_DOCUMENTS or PARENT_CHILD (in any case)",
    "c.updateStrategy must be ADD, UPDATE_MUST_EXIST or UPDATE_MUST_NOT_EXIST (in any case)",
  ]);
});

test("idField, embeddedFileFieldName and commitWithin are read, and a commitWithin of 0 or less is Tika's 1000", () => {
  const set = emitter({ idField: "doc_id", embeddedFileFieldName: "children", commitWithin: 250 }).result;
  assert.equal(set?.idField, "doc_id");
  assert.equal(set?.embeddedFileFieldName, "children");
  assert.equal(set?.commitWithin, 250);
  const zero = emitter({ commitWithin: 0 });
  assert.equal(zero.result?.commitWithin, 1000);
  assert.equal(zero.notices.filter((notice) => notice.startsWith("c.commitWithin")).length, 1);
  assert.equal(emitter({ commitWithin: -5 }).result?.commitWithin, 1000);
  assert.deepEqual(emitter({ commitWithin: 1.5, idField: "", embeddedFileFieldName: 3 }).issues, ["c.idField must be a non-empty string", "c.commitWithin must be an integer", "c.embeddedFileFieldName must be a non-empty string"]);
});

test("socketTimeoutMillis bounds a request and is Tika's 60000 when it is 0 or less; connectionTimeoutMillis is accepted and said to change nothing", () => {
  assert.equal(emitter({ socketTimeoutMillis: 5000 }).result?.solr.socketTimeoutMillis, 5000);
  assert.equal(emitter({ socketTimeoutMillis: 0 }).result?.solr.socketTimeoutMillis, 60000);
  assert.equal(emitter({ socketTimeoutMillis: 2147483648 }).issues[0], "c.socketTimeoutMillis must be an integer of at most 2147483647");
  assert.equal(emitter({ socketTimeoutMillis: "5" }).issues[0], "c.socketTimeoutMillis must be an integer of at most 2147483647");
  assert.equal(emitter({ connectionTimeoutMillis: 3000 }).notices.filter((notice) => notice.startsWith("c.connectionTimeoutMillis")).length, 1);
  assert.deepEqual(emitter({ connectionTimeoutMillis: 0 }).notices, []);
  assert.equal(emitter({ connectionTimeoutMillis: "x" }).issues[0], "c.connectionTimeoutMillis must be an integer");
});

test("userName and password are basic authentication, and any other authScheme with a userName is the error SolrClientHelper throws", () => {
  assert.deepEqual(emitter({ userName: "solr", password: "pw" }).result?.solr, { urls: [URL_A], collection: "docs", socketTimeoutMillis: 60000, userName: "solr", password: "pw" });
  assert.equal(emitter({ userName: "solr", password: "pw", authScheme: "BASIC" }).issues.length, 0);
  assert.deepEqual(emitter({ userName: "solr" }).issues, ["c.userName and password go together"]);
  assert.deepEqual(emitter({ userName: "solr", password: "pw", authScheme: "digest" }).issues, ['c.authScheme "digest" is not supported: ripstream sends basic authentication, which is all Tika\'s Solr client takes']);
  const ignored = emitter({ password: "pw", authScheme: "digest" });
  assert.equal(ignored.issues.length, 0);
  assert.equal(ignored.result?.solr.userName, undefined);
  assert.deepEqual(ignored.notices.map((notice) => notice.split(" ")[0]).sort(), ["c.authScheme", "c.password"], "with no userName Tika skips authentication, and so do these");
  assert.deepEqual(emitter({ userName: 3, password: false }).issues, ["c.userName must be a string", "c.password must be a string"]);
});

test("a proxy and switching certificate checks off are refused with the reason, as the Elasticsearch emitter refuses them", () => {
  assert.match(emitter({ proxyHost: "proxy.example.com" }).issues[0] ?? "", /^c\.proxyHost is not supported: Node's fetch has no per-client proxy setting/);
  assert.match(emitter({ proxyPort: 3128 }).issues[0] ?? "", /^c\.proxyPort is not supported: see proxyHost/);
  assert.match(emitter({ verifySsl: false }).issues[0] ?? "", /^c\.verifySsl false is refused: .*NODE_EXTRA_CA_CERTS/);
  assert.deepEqual([emitter({ proxyHost: "", proxyPort: 0, verifySsl: true }).issues, emitter({}).issues], [[], []]);
  assert.equal(emitter({ verifySsl: "no" }).issues[0], "c.verifySsl must be a boolean");
});

test("an iterator needs a collection, solrUrls, the four field names, a fetcher and an emitter, and has Tika's defaults", () => {
  assert.deepEqual(iterator({}).result, {
    type: "solr-pipes-iterator",
    solr: { urls: [URL_A], collection: "docs", socketTimeoutMillis: 60000 },
    filters: [],
    idField: "path",
    parsingIdField: "parsing_id",
    failCountField: "fail_count",
    sizeFieldName: "size",
    additionalFields: [],
    rows: 5000,
    fetcherId: "f",
    emitterId: "e",
  });
  assert.deepEqual(read((context) => parseSolrIterator({}, context)).issues, [
    "c.fetcherId is required and must be a non-empty string",
    "c.emitterId is required and must be a non-empty string",
    "c.idField is required and must be a non-empty string",
    "c.parsingIdField is required and must be a non-empty string",
    "c.failCountField is required and must be a non-empty string",
    "c.sizeFieldName is required and must be a non-empty string",
    "c.solrCollection is required and must be a non-empty string",
    "c.solrUrls is required: Tika's validate() wants either solrUrls or solrZkHosts",
  ]);
  assert.match(iterator({ solrUrls: undefined, solrZkHosts: ["zk:2181"] }).issues[0] ?? "", /^c\.solrZkHosts is not supported: .*ZooKeeper client/);
});

test("an iterator's filters and additionalFields are lists of strings, rows is a whole number of 1 or more, and it shares the connection settings", () => {
  const set = iterator({ filters: ["kind:pdf", "fail_count:0"], additionalFields: ["extra"], rows: 100, userName: "u", password: "p", socketTimeoutMillis: 9000 }).result;
  assert.deepEqual(set?.filters, ["kind:pdf", "fail_count:0"]);
  assert.deepEqual(set?.additionalFields, ["extra"]);
  assert.equal(set?.rows, 100);
  assert.deepEqual(set?.solr, { urls: [URL_A], collection: "docs", socketTimeoutMillis: 9000, userName: "u", password: "p" });
  assert.deepEqual(iterator({ filters: "kind:pdf", additionalFields: [1] }).issues, ["c.filters must be an array of non-empty strings", "c.additionalFields must be an array of non-empty strings"]);
  for (const bad of [0, -1, 1.5, "5000"]) assert.deepEqual(iterator({ rows: bad }).issues, ["c.rows must be a whole number of 1 or more"], String(bad));
  assert.match(iterator({ proxyHost: "p" }).issues[0] ?? "", /proxyHost is not supported/);
});
