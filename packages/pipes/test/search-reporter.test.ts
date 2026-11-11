import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchReporterSettings } from "@spikedpunch/ripstream-core";
import {
  MemoryEmitter,
  PipesEngine,
  SearchError,
  SearchPipesReporter,
  isTransientError,
  pipesResult,
  type FetchEmitTuple,
  type PipeDocument,
  type PipeFetchFailure,
  type PipesResult,
} from "../src/index.ts";
import { fakeSearch, type FakeSearch } from "./fixtures/fake-search.ts";

/*
 * Tika's es-pipes-reporter and opensearch-pipes-reporter (tikajs-68os.34), against a `_bulk` endpoint that records what it
 * is sent. The request bodies are what ESPipesReporter and the reporter's OpenSearchClient write (read from Tika's
 * source, not run against a Tika): nothing here ran against Elasticsearch or OpenSearch.
 */

async function withSearch(run: (search: FakeSearch) => Promise<void>): Promise<void> {
  const search = await fakeSearch();
  try {
    await run(search);
  } finally {
    await search.close();
  }
}

const settings = (search: FakeSearch, more: Partial<SearchReporterSettings> = {}): SearchReporterSettings => ({
  type: "es-pipes-reporter",
  url: `${search.url}/status`,
  keyPrefix: "",
  includeRouting: false,
  ...more,
});

const tuple = (id: string, emitKey?: string): FetchEmitTuple => ({ id, fetcher: "f", fetchKey: id, ...(emitKey === undefined ? {} : { emitKey }) });
const success = (id = "doc.pdf", elapsedMs = 1234): PipesResult => pipesResult(id, "PARSE_SUCCESS", elapsedMs);
const reporterFor = (config: SearchReporterSettings): SearchPipesReporter => new SearchPipesReporter({ settings: config });
const failureOf = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

// ---- the request ---------------------------------------------------------------------------------------------------

test("a result is one update action and a doc of parse_status and parse_time_ms, POSTed to <index url>/_bulk", async () => {
  await withSearch(async (search) => {
    await reporterFor(settings(search)).report(success("in/doc.pdf", 1234), tuple("in/doc.pdf"));
    const [request] = search.requests;
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "/status/_bulk");
    assert.equal(request?.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(request?.headers.accept, "application/json");
    assert.equal(
      request?.body,
      '{"update":{"_id":"in/doc.pdf","retry_on_conflict":3}}\n{"doc":{"parse_status":"PARSE_SUCCESS","parse_time_ms":"1234"},"doc_as_upsert":true}\n',
    );
  });
});

test("the status is the name of the result's status, whatever it is, and the time is its elapsed milliseconds as a string", async () => {
  await withSearch(async (search) => {
    await reporterFor(settings(search)).report(pipesResult("d", "FETCH_EXCEPTION", 0, "no such file"), tuple("d"));
    assert.deepEqual(search.lines()[0]?.[1], { doc: { parse_status: "FETCH_EXCEPTION", parse_time_ms: "0" }, doc_as_upsert: true });
  });
});

test("the document is the tuple's emit key, and its id when the tuple has none", async () => {
  await withSearch(async (search) => {
    const reporter = reporterFor(settings(search));
    await reporter.report(success(), tuple("in/a.pdf", "out/a.json"));
    await reporter.report(success(), tuple("in/b.pdf"));
    const ids = search.lines().map((lines) => (lines[0] as { update: { _id: string } }).update._id);
    assert.deepEqual(ids, ["out/a.json", "in/b.pdf"]);
  });
});

test("keyPrefix goes before both keys, for Elasticsearch and OpenSearch", async () => {
  await withSearch(async (search) => {
    for (const type of ["es-pipes-reporter", "opensearch-pipes-reporter"] as const) {
      await reporterFor(settings(search, { type, keyPrefix: "ripstream_" })).report(success(), tuple("d"));
    }
    for (const lines of search.lines()) assert.deepEqual(lines[1], { doc: { ripstream_parse_status: "PARSE_SUCCESS", ripstream_parse_time_ms: "1234" }, doc_as_upsert: true });
  });
});

test("includeRouting routes the update to the emit key, between the id and retry_on_conflict; without it there is no routing", async () => {
  await withSearch(async (search) => {
    await reporterFor(settings(search, { includeRouting: true })).report(success(), tuple("in/a.pdf", "out/a.json"));
    await reporterFor(settings(search, { includeRouting: false })).report(success(), tuple("in/a.pdf", "out/a.json"));
    assert.equal(search.requests[0]?.body.split("\n")[0], '{"update":{"_id":"out/a.json","routing":"out/a.json","retry_on_conflict":3}}');
    assert.equal(search.requests[1]?.body.split("\n")[0], '{"update":{"_id":"out/a.json","retry_on_conflict":3}}');
  });
});

test("an id with quotes, a newline and non-ASCII characters is one JSON string, so a document cannot break out of its line", async () => {
  await withSearch(async (search) => {
    const id = 'a "quoted"\nname é.pdf';
    await reporterFor(settings(search)).report(success(), tuple(id));
    assert.equal(search.requests[0]?.body.split("\n").length, 3, "an action line, a document line and the final newline");
    assert.equal((search.lines()[0]?.[0] as { update: { _id: string } }).update._id, id);
  });
});

test("a report without the input's tuple is refused, since the emit key is the document's id", async () => {
  await withSearch(async (search) => {
    await assert.rejects(Promise.resolve().then(() => reporterFor(settings(search)).report(success())), /es-pipes-reporter needs the tuple of the input/);
    assert.equal(search.requests.length, 0);
  });
});

// ---- includes and excludes -----------------------------------------------------------------------------------------

test("includes: only the results of the statuses it names are reported", async () => {
  await withSearch(async (search) => {
    const reporter = reporterFor(settings(search, { includes: ["PARSE_EXCEPTION_NO_EMIT", "FETCH_EXCEPTION"] }));
    await reporter.report(pipesResult("a", "EMIT_SUCCESS", 1), tuple("a"));
    await reporter.report(pipesResult("b", "FETCH_EXCEPTION", 1), tuple("b"));
    await reporter.report(pipesResult("c", "PARSE_SUCCESS", 1), tuple("c"));
    await reporter.report(pipesResult("d", "PARSE_EXCEPTION_NO_EMIT", 1), tuple("d"));
    assert.deepEqual(search.lines().map((lines) => (lines[0] as { update: { _id: string } }).update._id), ["b", "d"]);
  });
});

test("excludes: every result but those of the statuses it names is reported", async () => {
  await withSearch(async (search) => {
    const reporter = reporterFor(settings(search, { type: "opensearch-pipes-reporter", excludes: ["EMIT_SUCCESS"] }));
    await reporter.report(pipesResult("a", "EMIT_SUCCESS", 1), tuple("a"));
    await reporter.report(pipesResult("b", "EMIT_EXCEPTION", 1), tuple("b"));
    assert.deepEqual(search.lines().map((lines) => (lines[0] as { update: { _id: string } }).update._id), ["b"]);
  });
});

test("a result the filter drops needs no tuple and sends nothing", async () => {
  await withSearch(async (search) => {
    await reporterFor(settings(search, { includes: ["FETCH_EXCEPTION"] })).report(success());
    assert.equal(search.requests.length, 0);
  });
});

test("naming both includes and excludes, or a status that is not one, is refused when the reporter is made", async () => {
  await withSearch(async (search) => {
    assert.throws(() => reporterFor(settings(search, { includes: ["PARSE_SUCCESS"], excludes: ["EMIT_SUCCESS"] })), /only one of includes and excludes may be given/);
    assert.throws(() => reporterFor(settings(search, { includes: ["NOPE" as "EMIT_SUCCESS"] })), /includes names no result status: NOPE/);
  });
});

// ---- credentials ---------------------------------------------------------------------------------------------------

test("an apiKey is sent as Authorization: ApiKey and wins over a user name; a user name is basic authentication; neither is no header", async () => {
  await withSearch(async (search) => {
    await reporterFor(settings(search, { apiKey: "a2V5OnNlY3JldA==", userName: "elastic", password: "pw" })).report(success(), tuple("a"));
    await reporterFor(settings(search, { type: "opensearch-pipes-reporter", userName: "admin", password: "p:w" })).report(success(), tuple("b"));
    await reporterFor(settings(search)).report(success(), tuple("c"));
    assert.equal(search.requests[0]?.headers.authorization, "ApiKey a2V5OnNlY3JldA==");
    assert.equal(search.requests[1]?.headers.authorization, `Basic ${Buffer.from("admin:p:w").toString("base64")}`);
    assert.equal(search.requests[2]?.headers.authorization, undefined);
  });
});

// ---- failures ------------------------------------------------------------------------------------------------------
// Where Tika's reporter logs a failed report and goes on, this one throws: the engine ends the run on a reporter that
// throws, so that the operator's audit trail does not go missing quietly.

test("a status other than 200 is an error that carries the status and the service's own message", async () => {
  await withSearch(async (search) => {
    search.answer(400, '{"error":{"type":"illegal_argument_exception","reason":"no such index"}}');
    const failure = await failureOf(Promise.resolve(reporterFor(settings(search)).report(success(), tuple("d"))));
    assert.ok(failure instanceof SearchError);
    assert.equal(failure.status, 400);
    assert.match(failure.message, /es-pipes-reporter _bulk 400: .*no such index/);
    assert.equal(isTransientError(failure), false);
  });
});

test("a request the service rejected as busy (429, 503) is a transient error", async () => {
  await withSearch(async (search) => {
    for (const status of [429, 503]) {
      search.answer(status, "busy");
      const failure = await failureOf(Promise.resolve(reporterFor(settings(search, { type: "opensearch-pipes-reporter" })).report(success(), tuple("d"))));
      assert.equal(isTransientError(failure), true, String(status));
      assert.match((failure as Error).message, /opensearch-pipes-reporter _bulk/);
    }
  });
});

test("`errors: true` in a 200 answer is an error with the answer", async () => {
  await withSearch(async (search) => {
    search.answer(200, JSON.stringify({ took: 3, errors: true, items: [{ update: { _id: "d", status: 400, error: { type: "mapper_parsing_exception" } } }] }));
    const failure = await failureOf(Promise.resolve(reporterFor(settings(search)).report(success(), tuple("d"))));
    assert.ok(failure instanceof SearchError);
    assert.match(failure.message, /es-pipes-reporter _bulk reported errors: .*mapper_parsing_exception/);
  });
});

test("a 200 answer that is not JSON is an error", async () => {
  await withSearch(async (search) => {
    search.answer(200, "<html>a proxy's page</html>");
    await assert.rejects(Promise.resolve(reporterFor(settings(search)).report(success(), tuple("d"))), /answered 200 with a body that is not JSON: <html>/);
  });
});

test("socketTimeoutMillis is the time one request may take, and a redirect is an error", async () => {
  const seen: Array<{ signal: AbortSignal | undefined | null; redirect: unknown }> = [];
  const reporter = new SearchPipesReporter({
    settings: { type: "opensearch-pipes-reporter", url: "https://search.example/status", keyPrefix: "", includeRouting: false, socketTimeoutMillis: 5000 },
    transport: {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push({ signal: init.signal, redirect: init.redirect });
        return new Response('{"errors":false}', { status: 200 });
      }) as unknown as typeof fetch,
    },
  });
  await reporter.report(success(), tuple("d"));
  assert.ok(seen[0]?.signal instanceof AbortSignal);
  assert.equal(seen[0]?.signal.aborted, false);
  assert.equal(seen[0]?.redirect, "error");
});

// ---- in a run --------------------------------------------------------------------------------------------------------

const documents = (...inputs: Array<PipeDocument | PipeFetchFailure>): { fetch(): AsyncIterable<PipeDocument | PipeFetchFailure> } => ({
  async *fetch() {
    yield* inputs;
  },
});

test("a run reports each input to the index: its status and time under the input's id", async () => {
  await withSearch(async (search) => {
    const engine = new PipesEngine({
      source: documents({ id: "a.txt", data: new TextEncoder().encode("alpha") }, { id: "missing.txt", error: new Error("no such file") }),
      emitter: new MemoryEmitter(),
      concurrency: 1,
      reporter: reporterFor(settings(search)),
    });
    await engine.run();
    const sent = search.lines().map(([action, body]) => ({
      id: (action as { update: { _id: string } }).update._id,
      status: (body as { doc: { parse_status: string } }).doc.parse_status,
      time: (body as { doc: { parse_time_ms: string } }).doc.parse_time_ms,
    }));
    assert.deepEqual(
      sent.map(({ id, status }) => [id, status]),
      [
        ["a.txt", "EMIT_SUCCESS"],
        ["missing.txt", "FETCH_EXCEPTION"],
      ],
    );
    for (const { time } of sent) assert.match(time, /^\d+$/);
  });
});

test("a run whose report the index refuses ends with that error", async () => {
  await withSearch(async (search) => {
    search.answer(403, '{"error":"forbidden"}');
    const engine = new PipesEngine({
      source: documents({ id: "a.txt", data: new TextEncoder().encode("alpha") }),
      emitter: new MemoryEmitter(),
      reporter: reporterFor(settings(search)),
    });
    await assert.rejects(engine.run(), (error: unknown) => error instanceof SearchError && error.status === 403);
  });
});
