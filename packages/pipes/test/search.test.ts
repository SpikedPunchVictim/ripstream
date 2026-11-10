import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, type SearchEmitterSettings } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { BulkSearchEmitter, SearchError, createEngineFromSettings, isTransientError, type EmittedDocument } from "../src/index.ts";
import { fakeSearch, type FakeSearch } from "./fixtures/fake-search.ts";
import { storedZip } from "./helpers.ts";

/*
 * The Elasticsearch and OpenSearch emitters (tikajs-68os.6.6), against a `_bulk` endpoint that records what it is sent. The
 * request bodies are what Tika's ESClient and OpenSearchClient write (read from their source), not what a real index
 * accepted: nothing here ran against Elasticsearch or OpenSearch.
 */

async function withSearch(run: (search: FakeSearch) => Promise<void>): Promise<void> {
  const search = await fakeSearch();
  try {
    await run(search);
  } finally {
    await search.close();
  }
}

const settings = (search: FakeSearch, more: Partial<SearchEmitterSettings> = {}): SearchEmitterSettings => ({
  id: "idx",
  type: "es-emitter",
  url: `${search.url}/my-index`,
  updateStrategy: "OVERWRITE",
  embeddedFileFieldName: "embedded",
  ...more,
});

/** Ids that are the same on every run, where Tika draws a random UUID. */
const counting = (): (() => string) => {
  let count = 0;
  return () => `uuid-${++count}`;
};

const emitterFor = (config: SearchEmitterSettings): BulkSearchEmitter => new BulkSearchEmitter({ settings: config, transport: { randomId: counting() } });

const metadataDocument = (id: string, metadata: EmittedDocument["metadata"]): EmittedDocument => ({ id, mode: "NO_PARSE", metadata });

/** A zip with two entries, parsed to the container's record and one for each entry. */
async function zipRecords(): Promise<EmittedDocument> {
  const records = await createRipstream().parseRecursive(storedZip({ "one.txt": "first entry", "two.txt": "second entry" }), { filename: "outer.zip" });
  return { id: "outer.zip", mode: "RMETA", records };
}

// ---- the request ---------------------------------------------------------------------------------------------------

test("one document is POSTed to <index url>/_bulk as an index action and its fields, newline-delimited", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search)).emit(metadataDocument("doc.pdf", { "dc:title": "Title", "Content-Type": "application/pdf" }));
    const [request] = search.requests;
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "/my-index/_bulk");
    assert.equal(request?.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(request?.headers.accept, "application/json");
    assert.equal(request?.headers.authorization, undefined);
    assert.equal(request?.body, `{"index":{"_id":"doc.pdf"}}\n{"dc:title":"Title","Content-Type":"application/pdf"}\n`);
  });
});

test("UPSERT, which Tika's missing updateStrategy also is, sends an update action with doc_as_upsert and retry_on_conflict 3", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search, { updateStrategy: "UPSERT" })).emit(metadataDocument("doc.pdf", { "dc:title": "Title" }));
    assert.equal(search.requests[0]?.body, `{"update":{"_id":"doc.pdf","retry_on_conflict":3}}\n{"doc":{"dc:title":"Title"},"doc_as_upsert":true}\n`);
  });
});

test("a trailing slash on the index URL is dropped by the settings, so /_bulk is not doubled", async () => {
  const parsed = loadConfig({ emitters: { idx: { "es-emitter": { esUrl: "http://localhost:9200/my-index//", idField: "id" } } } }).pipes?.emitters[0];
  assert.equal((parsed as SearchEmitterSettings).url, "http://localhost:9200/my-index");
});

test("a key with one value is a string and a key with several is an array", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search)).emit(metadataDocument("d", { one: "a", many: ["x", "y"], number: 3, flag: true }));
    const [action, body] = search.lines()[0] ?? [];
    assert.deepEqual(action, { index: { _id: "d" } });
    assert.deepEqual(body, { one: "a", many: ["x", "y"], number: "3", flag: "true" }, "Tika writes every value as a string");
  });
});

test("a key declared JSON (tk:chunks) is written as JSON when it is, and as a string when it is not", async () => {
  await withSearch(async (search) => {
    const emitter = emitterFor(settings(search));
    await emitter.emit(metadataDocument("good", { "tk:chunks": '[{"text":"a","vector":[1,2]}]' }));
    await emitter.emit(metadataDocument("trailing", { "tk:chunks": '[1,2,3], "injected": true' }));
    await emitter.emit(metadataDocument("broken", { "tk:chunks": "[1,2" }));
    await emitter.emit(metadataDocument("plain", { "dc:title": '["not a json field"]' }));
    const bodies = search.lines().map((lines) => lines[1] as Record<string, unknown>);
    assert.deepEqual(bodies[0], { "tk:chunks": [{ text: "a", vector: [1, 2] }] });
    assert.deepEqual(bodies[1], { "tk:chunks": '[1,2,3], "injected": true' }, "nothing after the root value is allowed to become a field");
    assert.deepEqual(bodies[2], { "tk:chunks": "[1,2" });
    assert.deepEqual(bodies[3], { "dc:title": '["not a json field"]' }, "only keys declared JSON are read as JSON");
  });
});

test("a CONCATENATE document is one entry with its content as tk:content", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search)).emit({ id: "doc", mode: "CONCATENATE", text: "the body", metadata: { "Content-Type": "text/plain" } });
    assert.deepEqual(search.lines()[0]?.[1], { "Content-Type": "text/plain", "tk:content": "the body" });
  });
});

// ---- embedded documents --------------------------------------------------------------------------------------------

test("PARENT_CHILD with UPSERT routes every entry to the container's key and links the children to it", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search, { updateStrategy: "UPSERT", attachmentStrategy: "PARENT_CHILD", embeddedFileFieldName: "attachment" })).emit(await zipRecords());
    const lines = search.lines()[0] ?? [];
    assert.equal(lines.length, 6, "an action and a document for each of the container and its two entries");
    assert.deepEqual(lines[0], { update: { _id: "outer.zip", routing: "outer.zip", retry_on_conflict: 3 } });
    assert.equal((lines[1] as { doc_as_upsert: boolean }).doc_as_upsert, true);
    assert.equal((lines[1] as { doc: Record<string, unknown> }).doc.relation_type, "container");
    assert.deepEqual(lines[2], { update: { _id: "outer.zip-uuid-1", routing: "outer.zip", retry_on_conflict: 3 } });
    assert.deepEqual((lines[3] as { doc: Record<string, unknown> }).doc.relation_type, { name: "attachment", parent: "outer.zip" });
    assert.equal((lines[4] as { update: { _id: string } }).update._id, "outer.zip-uuid-2");
  });
});

test("SEPARATE_DOCUMENTS gives each child a parent field and the container nothing, with no routing", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search, { attachmentStrategy: "SEPARATE_DOCUMENTS" })).emit(await zipRecords());
    const lines = search.lines()[0] ?? [];
    assert.deepEqual(lines[0], { index: { _id: "outer.zip" } });
    assert.equal("parent" in (lines[1] as object), false);
    assert.equal("relation_type" in (lines[1] as object), false);
    assert.deepEqual(lines[2], { index: { _id: "outer.zip-uuid-1" } });
    assert.equal((lines[3] as { parent: string }).parent, "outer.zip");
    assert.equal((lines[5] as { parent: string }).parent, "outer.zip");
  });
});

test("without an attachmentStrategy, which Tika allows, the children carry no link to the container", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search)).emit(await zipRecords());
    const lines = search.lines()[0] ?? [];
    for (const index of [1, 3, 5]) {
      assert.equal("parent" in (lines[index] as object), false);
      assert.equal("relation_type" in (lines[index] as object), false);
    }
  });
});

test("an embedded document's id is the emit key and a UUID, as Tika draws one, so two emits do not share ids", async () => {
  await withSearch(async (search) => {
    const emitter = new BulkSearchEmitter({ settings: settings(search) });
    const document = await zipRecords();
    await emitter.emit(document);
    await emitter.emit(document);
    const ids = search.lines().map((lines) => (lines[2] as { index: { _id: string } }).index._id);
    assert.match(ids[0] ?? "", /^outer\.zip-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(ids[0], ids[1]);
  });
});

// ---- credentials ---------------------------------------------------------------------------------------------------

test("an apiKey is sent as Authorization: ApiKey, and wins over a user name, as in Tika", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search, { apiKey: "a2V5OnNlY3JldA==", userName: "elastic", password: "pw" })).emit(metadataDocument("d", { a: "b" }));
    assert.equal(search.requests[0]?.headers.authorization, "ApiKey a2V5OnNlY3JldA==");
  });
});

test("a user name and password are sent as basic authentication with the first request", async () => {
  await withSearch(async (search) => {
    await emitterFor(settings(search, { userName: "elastic", password: "p:w" })).emit(metadataDocument("d", { a: "b" }));
    assert.equal(search.requests[0]?.headers.authorization, `Basic ${Buffer.from("elastic:p:w").toString("base64")}`);
  });
});

// ---- failures ------------------------------------------------------------------------------------------------------

test("a status other than 200 is an error that carries the status and the service's own message", async () => {
  await withSearch(async (search) => {
    search.answer(400, '{"error":{"type":"illegal_argument_exception","reason":"no such index"}}');
    const failure = await emitterFor(settings(search)).emit(metadataDocument("d", { a: "b" })).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof SearchError);
    assert.equal(failure.status, 400);
    assert.match(failure.message, /es-emitter _bulk 400: .*no such index/);
    assert.equal(isTransientError(failure), false, "a request the service refused as wrong is not sent again");
  });
});

test("a whole request that was rejected (429, 503) is retried, as nothing in it was indexed", async () => {
  await withSearch(async (search) => {
    for (const status of [429, 503]) {
      search.answer(status, "busy");
      const failure = await emitterFor(settings(search)).emit(metadataDocument("d", { a: "b" })).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.equal(isTransientError(failure), true, String(status));
    }
  });
});

test("`errors: true` in a 200 answer is an error with the answer, and is not retried: its other entries were indexed", async () => {
  await withSearch(async (search) => {
    search.answer(200, JSON.stringify({ took: 3, errors: true, items: [{ index: { _id: "d", status: 429, error: { type: "es_rejected_execution_exception" } } }] }));
    const failure = await emitterFor(settings(search)).emit(metadataDocument("d", { a: "b" })).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof SearchError);
    assert.match(failure.message, /es-emitter _bulk reported errors: .*es_rejected_execution_exception/);
    assert.equal(isTransientError(failure), false);
  });
});

test("a 200 answer that is not JSON is an error", async () => {
  await withSearch(async (search) => {
    search.answer(200, "<html>a proxy's page</html>");
    await assert.rejects(emitterFor(settings(search)).emit(metadataDocument("d", { a: "b" })), /answered 200 with a body that is not JSON: <html>/);
  });
});

test("a long error answer is cut in the message", async () => {
  await withSearch(async (search) => {
    search.answer(500, "x".repeat(5000));
    await assert.rejects(emitterFor(settings(search)).emit(metadataDocument("d", { a: "b" })), (error: Error) => error.message.length < 1200 && /4000 more characters/.test(error.message));
  });
});

test("the bytes of an unpacked file and a CONTENT_ONLY document are refused: these emitters index metadata", async () => {
  await withSearch(async (search) => {
    const emitter = emitterFor(settings(search));
    await assert.rejects(emitter.emit({ id: "x-embed/1", bytes: new Uint8Array([1]) }), /es-emitter indexes metadata documents: it cannot emit the bytes of "x-embed\/1"/);
    await assert.rejects(emitter.emit({ id: "x", mode: "CONTENT_ONLY", text: "body" }), /cannot emit the content of "x"/);
    assert.equal(search.requests.length, 0);
  });
});

test("socketTimeoutMillis is the time one request may take", async () => {
  let signal: AbortSignal | undefined | null;
  const emitter = new BulkSearchEmitter({
    settings: { id: "idx", type: "opensearch-emitter", url: "http://localhost:9200/i", updateStrategy: "OVERWRITE", embeddedFileFieldName: "embedded", socketTimeoutMillis: 5000 },
    transport: {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        signal = init.signal;
        return new Response('{"errors":false}', { status: 200 });
      }) as unknown as typeof fetch,
    },
  });
  await emitter.emit(metadataDocument("d", { a: "b" }));
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test("a redirect is an error, so the credentials are not sent to another address", async () => {
  const seen: string[] = [];
  const emitter = new BulkSearchEmitter({
    settings: { id: "idx", type: "es-emitter", url: "https://search.example/i", updateStrategy: "OVERWRITE", embeddedFileFieldName: "embedded", apiKey: "k" },
    transport: {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push(String(init.redirect));
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    },
  });
  await assert.rejects(emitter.emit(metadataDocument("d", { a: "b" })), /not JSON/);
  assert.deepEqual(seen, ["error"]);
});

// ---- from a configuration ------------------------------------------------------------------------------------------

test("a Tika-shaped configuration indexes the metadata of each file, and the other emitter type shares the wire", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-search-"));
  try {
    const input = join(directory, "in");
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "a.txt"), "alpha");
    writeFileSync(join(input, "b.txt"), "beta");
    for (const [type, urlKey] of [
      ["es-emitter", "esUrl"],
      ["opensearch-emitter", "openSearchUrl"],
    ] as const) {
      await withSearch(async (search) => {
        const config = loadConfig({
          fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
          emitters: { idx: { [type]: { [urlKey]: `${search.url}/docs`, idField: "id", updateStrategy: "OVERWRITE", attachmentStrategy: "PARENT_CHILD", httpClientConfig: { userName: "u", password: "p" } } } },
          "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "idx" } },
          pipes: { parseMode: "RMETA" },
        });
        const engine = createEngineFromSettings(config.pipes!);
        await engine.run();
        assert.deepEqual(engine.stats.byStatus, { EMIT_SUCCESS: 2 }, type);
        const ids = search.lines().map((lines) => (lines[0] as { index: { _id: string; routing: string } }).index);
        assert.deepEqual(ids.map((index) => index._id).sort(), ["a.txt", "b.txt"]);
        assert.deepEqual(ids.map((index) => index.routing).sort(), ["a.txt", "b.txt"], "PARENT_CHILD routes by the emit key");
        assert.match(String(search.requests[0]?.headers.authorization), /^Basic /);
        const body = search.lines()[0]?.[1] as Record<string, string>;
        assert.match(body["tk:content"] ?? "", /alpha|beta/);
        assert.equal(body.relation_type, "container");
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a rejected request of a run is a result for its input, and the others still go through", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-search-"));
  try {
    const input = join(directory, "in");
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "a.txt"), "alpha");
    writeFileSync(join(input, "b.txt"), "beta");
    await withSearch(async (search) => {
      search.answer(400, "bad mapping");
      const config = loadConfig({
        fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
        emitters: { idx: { "es-emitter": { esUrl: `${search.url}/docs`, idField: "id", updateStrategy: "OVERWRITE" } } },
        "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "idx" } },
        pipes: { parseMode: "RMETA" },
      });
      const engine = createEngineFromSettings(config.pipes!);
      await engine.run();
      assert.equal(engine.stats.failed, 1);
      assert.deepEqual(engine.stats.byStatus, { EMIT_EXCEPTION: 1, EMIT_SUCCESS: 1 });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
