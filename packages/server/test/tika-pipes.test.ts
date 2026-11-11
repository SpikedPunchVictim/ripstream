import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IsolationError, loadConfig } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer, type ServerMimeType, type ServerRipstream } from "../src/index.ts";
import { readZip, storedZip } from "./fixtures/zip.ts";

/*
 * Tika's /pipes and /async (tikajs-68os.6.5): one FetchEmitTuple answered with its status, and {tuples:[...]} taken for a
 * background run. Tuples name the operator's fetchers and emitters; the batch job body of /pipes and the document body of
 * /async keep working beside them.
 */

interface Scratch {
  readonly input: string;
  readonly output: string;
}

async function scratch(run: (directory: Scratch) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-server-tika-pipes-"));
  const input = join(directory, "in");
  mkdirSync(input);
  try {
    await run({ input, output: join(directory, "out") });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function settingsFor({ input, output }: Scratch, pipes: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return loadConfig({
    fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
    emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", onExists: "REPLACE" } } },
    pipes: { parseMode: "RMETA", ...pipes },
    ...extra,
  }).pipes!;
}

interface Running {
  readonly port: number;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
}

async function serving<T>(
  options: Parameters<typeof createRipstreamServer>[0],
  run: (server: Running) => Promise<T>,
): Promise<T> {
  const instance = createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, authenticate: () => true, ...options });
  const port = await instance.listen();
  try {
    return await run({
      port,
      post: (path, body, headers = {}) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    });
  } finally {
    await instance.close();
  }
}

const tuple = (name: string, extra: Record<string, unknown> = {}) => ({ id: name, fetcher: "fsf", fetchKey: name, emitter: "fse", ...extra });

async function until(condition: () => boolean, what: string, milliseconds = 5_000): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The real parse, held at a gate until the test opens it. */
function gated(): { ripstream: ServerRipstream; open: () => void; started: () => number } {
  const real = createRipstream();
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  return {
    open: release,
    started: () => started,
    ripstream: {
      detect: (...args) => real.detect(...args),
      parse: (...args) => real.parse(...args),
      parseRecursive: async (...args) => {
        started++;
        await opened;
        return real.parseRecursive(...args);
      },
    },
  };
}

/** A parse that fails the way the isolation says it does. */
function failing(error: Error): ServerRipstream {
  const real = createRipstream();
  return {
    detect: (...args) => real.detect(...args),
    parse: (...args) => real.parse(...args),
    parseRecursive: () => Promise.reject(error),
  };
}

interface TikaAnswer {
  status: string;
  message?: string;
  added?: number;
  capacity?: number;
}

test("/pipes parses one tuple, emits it, and answers {status} with 200", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "content of a");
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      const response = await post("/pipes", tuple("a.txt"));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await response.json(), { status: "EMIT_SUCCESS" }, "Tika's body is the status, and a message when there is one");
      assert.match(readFileSync(join(paths.output, "a.txt.json"), "utf8"), /content of a/);
    });
  }));

test("/pipes answers a parse exception that was recorded with 200 and its message", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "bad.docx"), "PK\u0003\u0004 this is not a zip file at all");
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      const response = await post("/pipes", tuple("bad.docx"));
      assert.equal(response.status, 200, "Tika counts a recorded parse exception as success");
      const answer = (await response.json()) as TikaAnswer;
      assert.equal(answer.status, "EMIT_SUCCESS_PARSE_EXCEPTION");
      assert.equal(typeof answer.message, "string");
    });
  }));

test("/pipes gives each failure Tika's HTTP status: 400 for a component that is not there, 413 over a limit, 500 for a fetch", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "long.txt"), "x".repeat(5_000));
    await serving({ pipes: { settings: settingsFor(paths) }, defaultLimits: { maxOutputChars: 100 }, maxLimits: { maxOutputChars: 100 } }, async ({ post }) => {
      const noFetcher = await post("/pipes", tuple("long.txt", { fetcher: "nope" }));
      assert.equal(noFetcher.status, 400);
      assert.equal(((await noFetcher.json()) as TikaAnswer).status, "FETCHER_NOT_FOUND");

      const noEmitter = await post("/pipes", tuple("long.txt", { emitter: "nope" }));
      assert.equal(noEmitter.status, 400);
      assert.equal(((await noEmitter.json()) as TikaAnswer).status, "EMITTER_NOT_FOUND");

      const tooLong = await post("/pipes", tuple("long.txt"));
      assert.equal(tooLong.status, 413);
      assert.equal(((await tooLong.json()) as TikaAnswer).status, "PAYLOAD_LIMIT_EXCEEDED");

      const missing = await post("/pipes", tuple("not-there.txt"));
      assert.equal(missing.status, 500);
      const answer = (await missing.json()) as TikaAnswer;
      assert.equal(answer.status, "FETCH_EXCEPTION");
      assert.equal(typeof answer.message, "string");
      assert.equal(missing.headers.get("retry-after"), null, "a fetch that failed is not a thing to retry later");
    });
  }));

test("/pipes answers a child that crashed 503 with Retry-After 5, and a client pool that is full 429 with Retry-After 60", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "content");
    const settings = settingsFor(paths);
    await serving({ pipes: { settings }, ripstream: failing(new IsolationError("crash", "the child died")) }, async ({ post }) => {
      const response = await post("/pipes", tuple("a.txt"));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "5");
      assert.equal(((await response.json()) as TikaAnswer).status, "UNSPECIFIED_CRASH");
    });
    await serving({ pipes: { settings }, ripstream: failing(new IsolationError("queue_full", "no child free")) }, async ({ post }) => {
      const response = await post("/pipes", tuple("a.txt"));
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "60", "Tika's maxWaitForClientMillis, in seconds");
      assert.equal(((await response.json()) as TikaAnswer).status, "CLIENT_UNAVAILABLE_WITHIN_MS");
    });
  }));

test("/pipes refuses what a request may not do with 400: reserved ids, parseContext, a body that is not a tuple", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "content");
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      const reservedFetcher = await post("/pipes", tuple("a.txt", { fetcher: "__inline" }));
      assert.equal(reservedFetcher.status, 400);
      assert.match(await reservedFetcher.text(), /'__inline' is reserved .* fetcher/);

      const reservedEmitter = await post("/pipes", tuple("a.txt", { emitter: "__sink" }));
      assert.equal(reservedEmitter.status, 400);
      assert.match(await reservedEmitter.text(), /'__sink' is reserved .* emitter/);

      const withContext = await post("/pipes", tuple("a.txt", { parseContext: { "emit-strategy-config": { type: "PASSBACK_ALL" } } }));
      assert.equal(withContext.status, 400);
      assert.match(await withContext.text(), /parseContext/);

      const noFetcher = await post("/pipes", { fetchKey: "a.txt" });
      assert.equal(noFetcher.status, 400);
      assert.match(await noFetcher.text(), /fetcher is required/);

      const notJson = await post("/pipes", "{ not json");
      assert.equal(notJson.status, 400);
      assert.match(await notJson.text(), /Invalid JSON body/);

      const notAnObject = await post("/pipes", [tuple("a.txt")]);
      assert.equal(notAnObject.status, 400);
      assert.match(await notAnObject.text(), /a tuple must be a JSON object/);

      const notJsonType = await post("/pipes", tuple("a.txt"), { "content-type": "text/plain" });
      assert.equal(notJsonType.status, 415);

      assert.equal(existsSync(paths.output), false, "nothing was emitted for any of them");
    });
  }));

test("/pipes does not run the settings' reporters: the answer is the report, and a report file already there would fail the second request", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "content of a");
    writeFileSync(join(paths.input, "b.txt"), "content of b");
    const reportPath = join(paths.output, "..", "report.jsonl");
    const settings = settingsFor(paths, {}, { "pipes-reporters": { "file-system-jsonl-reporter": { path: reportPath } } });
    assert.equal(settings.reporters.length, 1, "the settings do have a reporter");
    await serving({ pipes: { settings } }, async ({ post }) => {
      assert.equal((await post("/pipes", tuple("a.txt"))).status, 200);
      assert.equal((await post("/pipes", tuple("b.txt"))).status, 200);
      assert.equal(existsSync(reportPath), false);
    });
  }));

test("/pipes still takes the batch job beside tuples, by the `source` it has", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "first");
    writeFileSync(join(paths.input, "b.txt"), "second");
    await serving({ pipes: { settings: settingsFor(paths), sourceRoot: paths.input } }, async ({ post }) => {
      const batch = await post("/pipes", { source: { type: "filesystem", path: "." } });
      assert.equal(batch.status, 200);
      const answer = (await batch.json()) as { count: number; stats: { fetched: number } };
      assert.equal(answer.stats.fetched, 2);
      assert.equal(answer.count, 2);

      const single = await post("/pipes", tuple("a.txt"));
      assert.equal(single.status, 200);
      assert.deepEqual(await single.json(), { status: "EMIT_SUCCESS" });
    });
  }));

test("a server with only settings refuses the batch job, and one with only a sourceRoot refuses a tuple, each saying which option it lacks", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "content");
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      const batch = await post("/pipes", { source: { type: "filesystem", path: "." } });
      assert.equal(batch.status, 400);
      assert.match(await batch.text(), /pipes\.sourceRoot/);
    });
    await serving({ pipes: { sourceRoot: paths.input } }, async ({ post }) => {
      const single = await post("/pipes", tuple("a.txt"));
      assert.equal(single.status, 400);
      assert.match(await single.text(), /pipes\.settings/);
    });
  }));

test("the pipes option needs a way to take work, and authenticate, and a sane wait", () =>
  scratch(async (paths) => {
    const settings = settingsFor(paths);
    assert.throws(() => createRipstreamServer({ ripstream: createRipstream(), pipes: {}, authenticate: () => true }), /needs `sourceRoot`.*or `settings`/);
    assert.throws(() => createRipstreamServer({ ripstream: createRipstream(), pipes: { settings } }), /requires `authenticate`/);
    for (const asyncMaxWaitMs of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () => createRipstreamServer({ ripstream: createRipstream(), authenticate: () => true, pipes: { settings, asyncMaxWaitMs } }),
        /asyncMaxWaitMs/,
        String(asyncMaxWaitMs),
      );
    }
  }));

test("/async takes {tuples}, answers {status: ok, added}, and processes them in the background; close() waits for them", () =>
  scratch(async (paths) => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(paths.input, name), `content of ${name}`);
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      const response = await post("/async", { tuples: [tuple("a.txt"), tuple("b.txt")] });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok", added: 2 });
      await until(() => existsSync(join(paths.output, "a.txt.json")) && existsSync(join(paths.output, "b.txt.json")), "both tuples to be emitted");

      const later = await post("/async", { tuples: [tuple("c.txt")] });
      assert.deepEqual(await later.json(), { status: "ok", added: 1 }, "the run goes on between requests");
      await until(() => existsSync(join(paths.output, "c.txt.json")), "the later tuple to be emitted");

      const empty = await post("/async", { tuples: [] });
      assert.deepEqual(await empty.json(), { status: "ok", added: 0 });
    });
    for (const name of ["a.txt", "b.txt", "c.txt"]) assert.match(readFileSync(join(paths.output, `${name}.json`), "utf8"), new RegExp(`content of ${name}`));
  }));

test("a server that is closed finishes the tuples /async took before it answered", () =>
  scratch(async (paths) => {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) writeFileSync(join(paths.input, name), `content of ${name}`);
    const gate = gated();
    await serving({ pipes: { settings: settingsFor(paths, { numClients: 1 }) }, ripstream: gate.ripstream }, async ({ post }) => {
      const response = await post("/async", { tuples: ["a.txt", "b.txt", "c.txt", "d.txt"].map((name) => tuple(name)) });
      assert.equal(response.status, 200);
      await until(() => gate.started() === 1, "the first parse to start");
      assert.equal(existsSync(paths.output), false, "nothing is done while the parse is held");
      gate.open();
    });
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      assert.equal(existsSync(join(paths.output, `${name}.json`)), true, `${name} was emitted before close() returned`);
    }
  }));

test("/async checks every tuple against the configured fetchers and emitters first, and queues none of a batch with one bad tuple", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "content");
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      const noFetcher = await post("/async", { tuples: [tuple("a.txt"), tuple("b.txt", { fetcher: "nope" })] });
      assert.equal(noFetcher.status, 400);
      assert.match(await noFetcher.text(), /can't find fetcher for nope/);

      const noEmitter = await post("/async", { tuples: [tuple("a.txt"), tuple("b.txt", { emitter: "nope" })] });
      assert.equal(noEmitter.status, 400);
      assert.match(await noEmitter.text(), /can't find emitter for nope/);

      const reserved = await post("/async", { tuples: [tuple("a.txt"), tuple("b.txt", { fetcher: "__inline" })] });
      assert.equal(reserved.status, 400);
      assert.match(await reserved.text(), /'__inline' is reserved/);

      const unparseable = await post("/async", { tuples: [tuple("a.txt"), { id: "x" }] });
      assert.equal(unparseable.status, 400);
      assert.match(await unparseable.text(), /tuples\[1\]: .*fetcher is required/);
    });
    assert.equal(existsSync(paths.output), false, "the good tuple that came with a bad one was not run");
  }));

test("a tuple that names no emitter goes to the only one configured; with none or several to choose from /async refuses it", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "a.txt"), "content of a");
    const { emitter: _named, ...unnamed } = tuple("a.txt");
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      assert.deepEqual(await (await post("/pipes", unnamed)).json(), { status: "EMIT_SUCCESS" });
      assert.equal(existsSync(join(paths.output, "a.txt.json")), true, "the only emitter wrote it");
      assert.deepEqual(await (await post("/async", { tuples: [unnamed] })).json(), { status: "ok", added: 1 });
    });

    const two = loadConfig({
      fetchers: { fsf: { "file-system-fetcher": { basePath: paths.input } } },
      emitters: {
        one: { "file-system-emitter": { basePath: join(paths.output, "one"), fileExtension: "json", onExists: "REPLACE" } },
        two: { "file-system-emitter": { basePath: join(paths.output, "two"), fileExtension: "json", onExists: "REPLACE" } },
      },
    }).pipes!;
    await serving({ pipes: { settings: two } }, async ({ post }) => {
      const response = await post("/async", { tuples: [unnamed] });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /tuples\[0\] names no emitter, and 2 are configured/);
    });
  }));

test("/async refuses a body that is not {tuples: [...]} with 400", () =>
  scratch(async (paths) => {
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      const notArray = await post("/async", { tuples: tuple("a.txt") });
      assert.equal(notArray.status, 400);
      assert.match(await notArray.text(), /tuples must be an array/);

      const extra = await post("/async", { tuples: [], more: 1 });
      assert.equal(extra.status, 400);
      assert.match(await extra.text(), /more is not a field/);
    });
  }));

test("/async answers a batch bigger than the queue 400, and a full queue 429 with the capacity and a Retry-After", () =>
  scratch(async (paths) => {
    const names = Array.from({ length: 12 }, (_, index) => `n${index}.txt`);
    for (const name of names) writeFileSync(join(paths.input, name), `content of ${name}`);
    const gate = gated();
    const settings = settingsFor(paths, { numClients: 1, queueSize: 2 });
    await serving({ pipes: { settings, asyncMaxWaitMs: 50 }, ripstream: gate.ripstream }, async ({ post }) => {
      try {
        const tooBig = await post("/async", { tuples: names.slice(0, 3).map((name) => tuple(name)) });
        assert.equal(tooBig.status, 400, "waiting would never make room for it");
        assert.match(await tooBig.text(), /exceeds the queue capacity \(2\)/);

        assert.equal((await post("/async", { tuples: [tuple(names[0]!)] })).status, 200);
        await until(() => gate.started() === 1, "the only worker to be inside the first parse");

        // One at a time until the queue says no. What it holds is the worker's tuple, the run's own queue (2) and the
        // offered queue (2), so this is a handful and not the twelve there are.
        const accepted: string[] = [names[0]!];
        let throttled: Response | undefined;
        for (const name of names.slice(1)) {
          const response = await post("/async", { tuples: [tuple(name)] });
          if (response.status === 200) {
            accepted.push(name);
            continue;
          }
          throttled = response;
          break;
        }
        assert.ok(throttled !== undefined, "a queue that is held full says no");
        assert.ok(accepted.length >= 3 && accepted.length <= 5, `took ${accepted.length} while the worker was held`);
        assert.equal(throttled.status, 429);
        assert.equal(throttled.headers.get("retry-after"), "1", "Tika: the wait it held for, in whole seconds, at least 1");
        const answer = (await throttled.json()) as TikaAnswer;
        assert.equal(answer.status, "throttled");
        assert.equal(answer.capacity, 0);
        assert.match(answer.message ?? "", /not able to receive request of size 1 at this time/);

        gate.open();
        const last = accepted.at(-1)!;
        await until(() => existsSync(join(paths.output, `${last}.json`)), "the queue to drain");
        for (const name of accepted) assert.equal(existsSync(join(paths.output, `${name}.json`)), true, `${name} was run`);
        const after = await post("/async", { tuples: [tuple(names[11]!)] });
        assert.equal(after.status, 200, "room again once it drained");
      } finally {
        // A failed assertion must not leave close() waiting for a parse that is held for ever.
        gate.open();
      }
    });
  }));

test("/async takes a document that is not a request for the old job, and gives that job its id", () =>
  scratch(async (paths) => {
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ port, post }) => {
      const raw = await fetch(`http://127.0.0.1:${port}/async?filename=a.txt`, { method: "POST", body: "plain document text" });
      assert.equal(raw.status, 202);
      const id = ((await raw.json()) as { id: string }).id;
      assert.equal(typeof id, "string");

      // JSON that is a document, not a request: it has no `tuples`.
      const json = await post("/async?filename=a.json", { title: "not a request" });
      assert.equal(json.status, 202);
      assert.equal(typeof ((await json.json()) as { id: string }).id, "string");

      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await fetch(`http://127.0.0.1:${port}/status/${id}`);
        if (((await status.json()) as { status: string }).status === "done") return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("the legacy job did not finish");
    });
  }));

test("with settings, a body that is not typed JSON is a document even when it reads like a request", () =>
  scratch(async (paths) => {
    await serving({ pipes: { settings: settingsFor(paths) } }, async ({ post }) => {
      const response = await post("/async?filename=a.txt", '{"tuples": []}', { "content-type": "text/plain" });
      assert.equal(response.status, 202, "the old job, not Tika's {status: ok}");
      assert.equal(typeof ((await response.json()) as { id: string }).id, "string");
    });
  }));

test("without settings /async takes every body as a document, a JSON body with `tuples` included", async () => {
  await serving({}, async ({ post }) => {
    const response = await post("/async?filename=a.json", { tuples: [] });
    assert.equal(response.status, 202);
  });
});

// ---- UNPACK: Tika's Frictionless package (tikajs-68os.6.7) -----------------------------------------------------------

const UNPACK_REGISTRY: ServerMimeType[] = [
  { type: "application/zip", extensions: [".zip"] },
  { type: "text/plain", extensions: [".txt"] },
  { type: "text/html", extensions: [".html"] },
  { type: "application/xml", extensions: [".xml"] },
];

test("/pipes in UNPACK mode writes Tika's package at `<emitKey>-frictionless.zip`, as it does by default", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "outer.zip"), storedZip({ "one.txt": "first", "two.html": "<p>second</p>" }));
    await serving({ pipes: { settings: settingsFor(paths, { parseMode: "UNPACK" }) } }, async ({ post }) => {
      const response = await post("/pipes", tuple("outer.zip"));
      assert.deepEqual(await response.json(), { status: "EMIT_SUCCESS" });
      assert.equal(existsSync(join(paths.output, "outer.zip.json")), false, "the package replaces the metadata document");
      const entries = readZip(readFileSync(join(paths.output, "outer.zip-frictionless.zip")));
      assert.deepEqual(entries.map((entry) => entry.name), ["datapackage.json", "rmeta.json", "unpacked/1", "unpacked/2"]);
    });
  }));

test("/pipes in UNPACK mode follows the configuration's unpack-config: REGULAR puts each document's bytes under its own key", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "outer.zip"), storedZip({ "one.txt": "first", "two.html": "<p>second</p>" }));
    const settings = settingsFor(paths, { parseMode: "UNPACK" }, { "parse-context": { "unpack-config": { outputFormat: "REGULAR" } } });
    await serving({ pipes: { settings } }, async ({ post }) => {
      assert.deepEqual(await post("/pipes", tuple("outer.zip")).then((response) => response.json()), { status: "EMIT_SUCCESS" });
      assert.match(readFileSync(join(paths.output, "outer.zip.json"), "utf8"), /one\.txt/);
      assert.equal(readFileSync(join(paths.output, "outer.zip-embed", "1"), "utf8"), "first", "the fileExtension is for the metadata document only");
    });
  }));

// A text or HTML document's Content-Type carries a charset (`text/plain; charset=windows-1252`), which Tika's registry
// does not know as a type: it names the file `.bin`. A type that carries no parameter, XML here, keeps its extension.
test("a DETECTED suffix is the server's registry extension, so a /pipes package and PUT /unpack name their files alike", () =>
  scratch(async (paths) => {
    const container = storedZip({ "one.txt": "first", "two.html": "<p>second</p>", "three.xml": "<a>third</a>" });
    writeFileSync(join(paths.input, "outer.zip"), container);
    const settings = settingsFor(paths, { parseMode: "UNPACK" }, { "parse-context": { "unpack-config": { suffixStrategy: "DETECTED" } } });
    await serving({ mimeTypes: UNPACK_REGISTRY, pipes: { settings } }, async ({ post, port }) => {
      assert.deepEqual(await post("/pipes", tuple("outer.zip")).then((response) => response.json()), { status: "EMIT_SUCCESS" });
      const fromPipes = readZip(readFileSync(join(paths.output, "outer.zip-frictionless.zip")));
      const response = await fetch(`http://127.0.0.1:${port}/unpack`, { method: "PUT", body: container });
      const fromServer = readZip(new Uint8Array(await response.arrayBuffer()));
      assert.deepEqual(fromPipes.map((entry) => entry.name), fromServer.map((entry) => entry.name));
      assert.deepEqual(fromPipes.map((entry) => entry.name), ["datapackage.json", "rmeta.json", "unpacked/1.bin", "unpacked/2.bin", "unpacked/3.xml"]);
      for (const name of ["unpacked/1.bin", "unpacked/2.bin", "unpacked/3.xml"]) {
        assert.deepEqual(fromPipes.find((entry) => entry.name === name)?.data, fromServer.find((entry) => entry.name === name)?.data, name);
      }
      // The manifests agree on everything but when they were made and what they are named after.
      const resources = (entries: typeof fromPipes) =>
        (JSON.parse(entries[0]?.data.toString("utf8") ?? "{}") as { resources: unknown[] }).resources;
      assert.deepEqual(resources(fromPipes).slice(1), resources(fromServer).slice(1));
    });
  }));

test("/async in UNPACK mode writes the same package in the background", () =>
  scratch(async (paths) => {
    writeFileSync(join(paths.input, "outer.zip"), storedZip({ "one.txt": "first" }));
    await serving({ mimeTypes: UNPACK_REGISTRY, pipes: { settings: settingsFor(paths, { parseMode: "UNPACK" }, { "parse-context": { "unpack-config": { suffixStrategy: "DETECTED" } } }) } }, async ({ post }) => {
      const response = await post("/async", { tuples: [tuple("outer.zip")] });
      assert.equal(response.status, 200);
      const file = join(paths.output, "outer.zip-frictionless.zip");
      await until(() => existsSync(file), "the package");
      assert.deepEqual(readZip(readFileSync(file)).map((entry) => entry.name), ["datapackage.json", "rmeta.json", "unpacked/1.bin"]);
    });
  }));
