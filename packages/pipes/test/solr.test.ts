import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { SolrEmitterSettings, SolrIteratorSettings } from "@spikedpunch/ripstream-core";
import { SolrEmitter, SolrError, SolrPipesIterator, isTransientError, type EmittedDocument, type FetchEmitTuple } from "../src/index.ts";
import { fakeSolr, type FakeSolr } from "./fixtures/fake-solr.ts";

/*
 * The Solr components (tikajs-68os.33), against a Solr in memory that stores what the JSON update handler is given and
 * answers /select with a cursor the way Solr does. Not run against Apache Solr: that the documents of the update request
 * are the ones SolrJ's UpdateRequest would send is read from Tika's SolrEmitter, and that Solr takes them as JSON is from
 * Solr's documentation.
 */

async function withSolr(run: (solr: FakeSolr) => Promise<void>, options: Parameters<typeof fakeSolr>[1] = {}): Promise<void> {
  const solr = await fakeSolr("docs", options);
  try {
    await run(solr);
  } finally {
    await solr.close();
  }
}

const emitterSettings = (url: string | readonly string[], over: Partial<SolrEmitterSettings> = {}): SolrEmitterSettings => ({
  id: "solr",
  type: "solr-emitter",
  solr: { urls: typeof url === "string" ? [url] : url, collection: "docs", socketTimeoutMillis: 60000 },
  idField: "id",
  commitWithin: 1000,
  attachmentStrategy: "PARENT_CHILD",
  updateStrategy: "ADD",
  embeddedFileFieldName: "embedded",
  ...over,
});

const iteratorSettings = (url: string | readonly string[], over: Partial<SolrIteratorSettings> = {}): SolrIteratorSettings => ({
  type: "solr-pipes-iterator",
  solr: { urls: typeof url === "string" ? [url] : url, collection: "docs", socketTimeoutMillis: 60000 },
  filters: [],
  idField: "path",
  parsingIdField: "parsing_id",
  failCountField: "fail_count",
  sizeFieldName: "size",
  additionalFields: [],
  rows: 5000,
  fetcherId: "f",
  emitterId: "e",
  ...over,
});

let counter = 0;
const randomId = (): string => `uuid-${++counter}`;
const sent = (solr: FakeSolr, index = 0): { url: URL; docs: Array<Record<string, unknown>> } => {
  const request = solr.requests[index];
  assert.ok(request, `request ${index}`);
  return { url: new URL(request.url, "http://fake"), docs: request.body === "" ? [] : (JSON.parse(request.body) as Array<Record<string, unknown>>) };
};
/** The list of an RMETA document: the first entry is the container's. */
const list = (id: string, ...objects: Array<Record<string, string | number | boolean | string[]>>): EmittedDocument => ({ id, mode: "RMETA", objects });

async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/solr`;
}

test("an ADD emit sends one JSON update with the emit key as the id, commitWithin and failOnVersionConflicts=false, and the fields as plain values", async () => {
  await withSolr(async (solr) => {
    const emitter = new SolrEmitter({ settings: emitterSettings(solr.url) });
    await emitter.emit(list("a.pdf", { "Content-Type": "application/pdf", "dc:creator": ["Ann", "Bob"], pages: 12, draft: false, empty: [] }));
    const { url, docs } = sent(solr);
    assert.equal(url.pathname, "/solr/docs/update");
    assert.equal(url.searchParams.get("commitWithin"), "1000");
    assert.equal(url.searchParams.get("failOnVersionConflicts"), "false");
    assert.match(String(solr.requests[0]?.headers["content-type"]), /^application\/json/);
    assert.deepEqual(docs, [{ id: "a.pdf", "Content-Type": "application/pdf", "dc:creator": ["Ann", "Bob"], pages: "12", draft: "false" }]);
    assert.deepEqual(solr.docs.get("a.pdf"), docs[0]);
  });
});

test("a document with a metadata record and content is the one document CONCATENATE gives, with tk:content as a field", async () => {
  await withSolr(async (solr) => {
    await new SolrEmitter({ settings: emitterSettings(solr.url) }).emit({ id: "b.txt", mode: "CONCATENATE", metadata: { "Content-Type": "text/plain" }, text: "body" });
    assert.deepEqual(sent(solr).docs, [{ id: "b.txt", "Content-Type": "text/plain", "tk:content": "body" }]);
  });
});

test("PARENT_CHILD puts the embedded documents under embeddedFileFieldName, each with the id emitKey-<uuid>", async () => {
  await withSolr(async (solr) => {
    counter = 0;
    const emitter = new SolrEmitter({ settings: emitterSettings(solr.url, { embeddedFileFieldName: "attachments" }), transport: { randomId } });
    await emitter.emit(list("zip.zip", { a: "container" }, { a: "first", b: ["x", "y"] }, { a: "second" }));
    assert.deepEqual(sent(solr).docs, [
      {
        id: "zip.zip",
        a: "container",
        attachments: [
          { id: "zip.zip-uuid-1", a: "first", b: ["x", "y"] },
          { id: "zip.zip-uuid-2", a: "second" },
        ],
      },
    ]);
  });
});

test("SEPARATE_DOCUMENTS sends the container and each embedded document as documents of the one request", async () => {
  await withSolr(async (solr) => {
    counter = 0;
    const emitter = new SolrEmitter({ settings: emitterSettings(solr.url, { attachmentStrategy: "SEPARATE_DOCUMENTS" }), transport: { randomId } });
    await emitter.emit(list("zip.zip", { a: "container" }, { a: "first" }, { a: "second" }));
    assert.equal(solr.requests.length, 1);
    assert.deepEqual(sent(solr).docs, [
      { id: "zip.zip", a: "container" },
      { id: "zip.zip-uuid-1", a: "first" },
      { id: "zip.zip-uuid-2", a: "second" },
    ]);
  });
});

test("a list of one entry is one document whichever the attachment strategy", async () => {
  await withSolr(async (solr) => {
    for (const attachmentStrategy of ["PARENT_CHILD", "SEPARATE_DOCUMENTS"] as const) {
      await new SolrEmitter({ settings: emitterSettings(solr.url, { attachmentStrategy }) }).emit(list(`only-${attachmentStrategy}`, { a: "1" }));
    }
    assert.deepEqual(sent(solr, 0).docs, [{ id: "only-PARENT_CHILD", a: "1" }]);
    assert.deepEqual(sent(solr, 1).docs, [{ id: "only-SEPARATE_DOCUMENTS", a: "1" }]);
  });
});

test("UPDATE_MUST_EXIST sends _version_ 1 and UPDATE_MUST_NOT_EXIST -1, with each field as {set: value}, a single value or an array", async () => {
  await withSolr(async (solr) => {
    await new SolrEmitter({ settings: emitterSettings(solr.url, { updateStrategy: "UPDATE_MUST_EXIST" }) }).emit(list("a", { title: "T", tags: ["x", "y"] }));
    await new SolrEmitter({ settings: emitterSettings(solr.url, { updateStrategy: "UPDATE_MUST_NOT_EXIST" }) }).emit(list("b", { title: "T" }));
    assert.deepEqual(sent(solr, 0).docs, [{ id: "a", _version_: 1, title: { set: "T" }, tags: { set: ["x", "y"] } }]);
    assert.deepEqual(sent(solr, 1).docs, [{ id: "b", _version_: -1, title: { set: "T" } }]);
  });
});

test("an update strategy other than ADD gives the root document the _version_ and the embedded documents only the {set} fields", async () => {
  await withSolr(async (solr) => {
    counter = 0;
    const settings = emitterSettings(solr.url, { updateStrategy: "UPDATE_MUST_EXIST" });
    await new SolrEmitter({ settings, transport: { randomId } }).emit(list("zip", { a: "c" }, { a: "e" }));
    assert.deepEqual(sent(solr).docs, [{ id: "zip", _version_: 1, a: { set: "c" }, embedded: [{ id: "zip-uuid-1", a: { set: "e" } }] }]);
  });
});

test("idField and commitWithin of the settings are used, and a metadata field named like the id field replaces the id as Tika's setField does", async () => {
  await withSolr(async (solr) => {
    const emitter = new SolrEmitter({ settings: emitterSettings(solr.url, { idField: "doc_id", commitWithin: 250 }) });
    await emitter.emit(list("k1", { a: "1" }));
    await emitter.emit(list("k2", { doc_id: "mine" }));
    assert.deepEqual(sent(solr, 0).docs, [{ doc_id: "k1", a: "1" }]);
    assert.equal(sent(solr, 0).url.searchParams.get("commitWithin"), "250");
    assert.deepEqual(sent(solr, 1).docs, [{ doc_id: "mine" }]);
  });
});

test("a metadata key that is __proto__ is a field like any other", async () => {
  await withSolr(async (solr) => {
    await new SolrEmitter({ settings: emitterSettings(solr.url) }).emit({ id: "p", mode: "RMETA", objects: [JSON.parse('{"__proto__": "x", "a": "1"}') as Record<string, string>] });
    assert.equal(solr.requests[0]?.body, '[{"id":"p","__proto__":"x","a":"1"}]');
  });
});

test("an emitter indexes metadata documents: content and bytes are refused, and an empty list sends nothing, as Tika's warns and returns", async () => {
  await withSolr(async (solr) => {
    const emitter = new SolrEmitter({ settings: emitterSettings(solr.url) });
    await assert.rejects(emitter.emit({ id: "c", mode: "CONTENT_ONLY", text: "x" }), /solr-emitter indexes metadata documents: it cannot emit the content of "c"/);
    await assert.rejects(emitter.emit({ id: "d", bytes: new Uint8Array([1]) }), /it cannot emit the bytes of "d"/);
    await emitter.emit({ id: "e", mode: "RMETA", objects: [] });
    assert.equal(solr.requests.length, 0);
  });
});

test("userName and password are sent as basic authentication, and a wrong password is a 401 that is not retried", async () => {
  await withSolr(
    async (solr) => {
      const settings = (password: string) => emitterSettings(solr.url, { solr: { urls: [solr.url], collection: "docs", socketTimeoutMillis: 60000, userName: "solr", password } });
      await new SolrEmitter({ settings: settings("SolrRocks") }).emit(list("a", { x: "1" }));
      assert.equal(solr.requests[0]?.headers.authorization, `Basic ${Buffer.from("solr:SolrRocks").toString("base64")}`);
      assert.ok(solr.docs.has("a"));
      const error = (await new SolrEmitter({ settings: settings("wrong") }).emit(list("b", { x: "1" })).catch((caught: unknown) => caught)) as SolrError;
      assert.ok(error instanceof SolrError);
      assert.equal(error.status, 401);
      assert.equal(error.message, "Solr update 401: require authentication");
      assert.equal(isTransientError(error), false);
      assert.ok(!solr.docs.has("b"));
    },
    { auth: { userName: "solr", password: "SolrRocks" } },
  );
});

test("a Solr error is a SolrError with the status and the message of its error body, and a 503 is the kind a retry may help", async () => {
  await withSolr(async (solr) => {
    const emitter = new SolrEmitter({ settings: emitterSettings(solr.url) });
    solr.answerNext(400, { responseHeader: { status: 400, QTime: 1 }, error: { msg: "ERROR: [doc=a] unknown field 'nope'", code: 400 } });
    const rejected = (await emitter.emit(list("a", { nope: "1" })).catch((caught: unknown) => caught)) as SolrError;
    assert.equal(rejected.message, "Solr update 400: ERROR: [doc=a] unknown field 'nope'");
    assert.equal(isTransientError(rejected), false);
    solr.answerNext(503, "Service Unavailable");
    const busy = (await emitter.emit(list("a", { x: "1" })).catch((caught: unknown) => caught)) as SolrError;
    assert.equal(busy.status, 503);
    assert.match(busy.message, /^Solr update 503/);
    assert.equal(isTransientError(busy), true);
  });
});

test("a 200 whose responseHeader.status is not 0 is Bad status, as Tika's, and a body that is not JSON is an error", async () => {
  await withSolr(async (solr) => {
    const emitter = new SolrEmitter({ settings: emitterSettings(solr.url) });
    solr.answerNext(200, { responseHeader: { status: 500, QTime: 3 } });
    await assert.rejects(emitter.emit(list("a", { x: "1" })), /Bad status: \{"responseHeader":\{"status":500/);
    solr.answerNext(200, "<html>proxy</html>");
    await assert.rejects(emitter.emit(list("a", { x: "1" })), /Solr update answered 200 with a body that is not JSON/);
  });
});

test("with several solrUrls a URL nothing listens on is skipped, and one that answers with an error is not", async () => {
  await withSolr(async (solr) => {
    const dead = await deadUrl();
    await new SolrEmitter({ settings: emitterSettings([dead, solr.url]) }).emit(list("a", { x: "1" }));
    assert.ok(solr.docs.has("a"), "the second URL took it");
    solr.answerNext(400, { error: { msg: "bad", code: 400 } });
    await assert.rejects(new SolrEmitter({ settings: emitterSettings([solr.url, dead]) }).emit(list("b", { x: "1" })), /Solr update 400: bad/);
    const failure = (await new SolrEmitter({ settings: emitterSettings([dead, dead]) }).emit(list("c", { x: "1" })).catch((caught: unknown) => caught)) as SolrError;
    assert.match(failure.message, /^Solr update could not connect to http:\/\/127\.0\.0\.1:\d+\/solr, http:\/\/127\.0\.0\.1:\d+\/solr: /);
    assert.equal(isTransientError(failure), true, "a connection refused is one a retry may help");
  });
});

test("socketTimeoutMillis bounds a request, and a request that takes longer is an error that names it", async () => {
  await withSolr(async (solr) => {
    solr.delayMs = 300;
    const settings = emitterSettings(solr.url, { solr: { urls: [solr.url], collection: "docs", socketTimeoutMillis: 40 } });
    const error = await new SolrEmitter({ settings }).emit(list("a", { x: "1" })).catch((caught: unknown) => caught);
    assert.match(String((error as Error).message), /^Solr update timed out after 40 ms$/);
    assert.equal(isTransientError(error), true, "a timeout is one a retry may help");
  });
});

async function tuplesOf(iterator: SolrPipesIterator): Promise<FetchEmitTuple[]> {
  const tuples: FetchEmitTuple[] = [];
  for await (const tuple of iterator) tuples.push(tuple);
  return tuples;
}

const seed = (solr: FakeSolr, count: number, extra: (index: number) => Record<string, unknown> = () => ({})): void => {
  for (let index = 1; index <= count; index++) {
    const id = `doc-${String(index).padStart(2, "0")}`;
    solr.docs.set(id, { id, path: `/in/${id}.pdf`, parsing_id: index % 2 === 0 ? "b" : "a", fail_count: "0", size: 100 + index, secret: "not asked for", ...extra(index) });
  }
};

test("the iterator asks for q=*:*, rows, the fields, the sort and a cursor from *, and ends when the cursor comes back as it was sent", async () => {
  await withSolr(async (solr) => {
    seed(solr, 5);
    const found = await tuplesOf(new SolrPipesIterator({ settings: iteratorSettings(solr.url, { rows: 2, additionalFields: ["extra", "path"] }) }));
    // parsing_id asc, then id asc: the "a" documents (1, 3, 5) and then the "b" ones (2, 4).
    assert.deepEqual(found.map((tuple) => tuple.id), ["/in/doc-01.pdf", "/in/doc-03.pdf", "/in/doc-05.pdf", "/in/doc-02.pdf", "/in/doc-04.pdf"]);
    assert.deepEqual(found[0], { id: "/in/doc-01.pdf", fetcher: "f", fetchKey: "/in/doc-01.pdf", emitter: "e", emitKey: "/in/doc-01.pdf" });
    const first = sent(solr, 0).url;
    assert.equal(first.pathname, "/solr/docs/select");
    assert.equal(first.searchParams.get("q"), "*:*");
    assert.equal(first.searchParams.get("rows"), "2");
    assert.equal(first.searchParams.get("fl"), "id,path,parsing_id,fail_count,size,extra");
    assert.equal(first.searchParams.get("sort"), "parsing_id asc,id asc");
    assert.equal(first.searchParams.get("cursorMark"), "*");
    assert.deepEqual(first.searchParams.getAll("fq"), []);
    assert.deepEqual(solr.requests.map((request) => new URL(request.url, "http://fake").searchParams.get("cursorMark")), ["*", "c2", "c4", "c5"], "3 pages and then the empty one that ends it");
  });
});

test("filters are sent as one fq each and narrow the query", async () => {
  await withSolr(async (solr) => {
    seed(solr, 4, (index) => ({ kind: index <= 2 ? "pdf" : "doc" }));
    const found = await tuplesOf(new SolrPipesIterator({ settings: iteratorSettings(solr.url, { filters: ["kind:pdf", "fail_count:0"] }) }));
    assert.deepEqual(found.map((tuple) => tuple.id), ["/in/doc-01.pdf", "/in/doc-02.pdf"]);
    assert.deepEqual(sent(solr, 0).url.searchParams.getAll("fq"), ["kind:pdf", "fail_count:0"]);
  });
});

test("an empty collection ends after one query with no tuple", async () => {
  await withSolr(async (solr) => {
    assert.deepEqual(await tuplesOf(new SolrPipesIterator({ settings: iteratorSettings(solr.url) })), []);
    assert.equal(solr.requests.length, 1);
  });
});

test("a document with no string in the id field ends the run with an error that names it, and so does a Solr error, where Tika logs it and goes on", async () => {
  await withSolr(async (solr) => {
    seed(solr, 2, (index) => (index === 2 ? { path: 7 } : {}));
    await assert.rejects(tuplesOf(new SolrPipesIterator({ settings: iteratorSettings(solr.url) })), /Solr document "doc-02" has no string in its path field/);
    solr.answerNext(400, { error: { msg: "undefined field: \"parsing_id\"", code: 400 } });
    await assert.rejects(tuplesOf(new SolrPipesIterator({ settings: iteratorSettings(solr.url) })), /Solr select 400: undefined field: "parsing_id"/);
  });
});

test("a cursor that does not come back is an error and not a loop", async () => {
  await withSolr(async (solr) => {
    solr.answerNext(200, { responseHeader: { status: 0 }, response: { numFound: 0, docs: [] } });
    await assert.rejects(tuplesOf(new SolrPipesIterator({ settings: iteratorSettings(solr.url) })), /Solr select answered with no nextCursorMark/);
  });
});

test("the iterator sends basic authentication, and goes to the next URL when one cannot be reached", async () => {
  await withSolr(
    async (solr) => {
      seed(solr, 1);
      const dead = await deadUrl();
      const settings = iteratorSettings([dead, solr.url], { solr: { urls: [dead, solr.url], collection: "docs", socketTimeoutMillis: 60000, userName: "solr", password: "pw" } });
      assert.equal((await tuplesOf(new SolrPipesIterator({ settings }))).length, 1);
      assert.equal(solr.requests[0]?.headers.authorization, `Basic ${Buffer.from("solr:pw").toString("base64")}`);
    },
    { auth: { userName: "solr", password: "pw" } },
  );
});

test("the enumeration ends when Solr gives the cursor back as it was sent, even on a page that has documents (Tika's rule)", async () => {
  const cursors: Array<string | null> = [];
  const fetchImpl = (async (url: string) => {
    cursors.push(new URL(url).searchParams.get("cursorMark"));
    // An iterator that does not stop at the repeated cursor would ask for ever: fail it instead of hanging the test.
    if (cursors.length > 3) throw new Error("runaway enumeration: the cursor came back as sent and the iterator went on");
    return new Response(JSON.stringify({ responseHeader: { status: 0 }, response: { docs: [{ path: "a" }] }, nextCursorMark: "*" }));
  }) as unknown as typeof fetch;
  const found = await tuplesOf(new SolrPipesIterator({ settings: iteratorSettings("http://solr.test/solr"), transport: { fetchImpl } }));
  assert.deepEqual(found.map((tuple) => tuple.id), ["a"]);
  assert.deepEqual(cursors, ["*"]);
});
