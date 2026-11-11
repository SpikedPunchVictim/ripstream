import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RipstreamConfig, loadConfig, metadataFiltersOf, type EmitMetadataFilters, type LanguageIdentifier } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer, type ServerMimeType } from "../src/index.ts";
import { readZip, storedZip } from "./fixtures/zip.ts";

/*
 * `metadata-filters` on the endpoints (tikajs-68os.9.2.6). Tika's server answers from the pipes, whose emit runs the
 * configured chain on the metadata list (RMETA: /rmeta, /meta, /unpack's rmeta.json; CONCATENATE: /tika/json) and, for
 * CONTENT_ONLY (the text routes), the parse-context chain alone, its own default being the content and the container
 * exception. A server with no chain answers as it did before.
 */

const registry: ServerMimeType[] = [
  { type: "application/zip", extensions: [".zip"] },
  { type: "text/plain", extensions: [".txt"] },
];

type Entry = { readonly name: string; readonly settings?: Record<string, unknown> };
const filters = (configured: readonly Entry[] = [], parseContext: readonly Entry[] = []): EmitMetadataFilters =>
  metadataFiltersOf(new RipstreamConfig({ metadataFilters: configured, parseContextMetadataFilters: parseContext }));

const include = (...names: string[]): Entry => ({ name: "include-field-metadata-filter", settings: { include: names } });
const exclude = (...names: string[]): Entry => ({ name: "exclude-field-metadata-filter", settings: { exclude: names } });
const removeMime = (...mimes: string[]): Entry => ({ name: "remove-by-mime-metadata-filter", settings: { mimes } });

async function withServer<T>(metadataFilters: EmitMetadataFilters | undefined, run: (base: string) => Promise<T>): Promise<T> {
  const instance = createRipstreamServer({
    ripstream: createRipstream(),
    log: () => undefined,
    mimeTypes: registry,
    ...(metadataFilters === undefined ? {} : { metadataFilters }),
  });
  const port = await instance.listen();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await instance.close();
  }
}

const TEXT = "Hello filters";
const json = { Accept: "application/json" };
const put = (base: string, path: string, headers: Record<string, string> = {}, body: Uint8Array | string = TEXT): Promise<Response> =>
  fetch(`${base}${path}`, { method: "PUT", body, headers });
const record = async (response: Response): Promise<Record<string, unknown>> => {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as Record<string, unknown>;
};
const records = async (response: Response): Promise<Array<Record<string, unknown>>> => {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as Array<Record<string, unknown>>;
};
const keys = (object: Record<string, unknown> | undefined): string[] => Object.keys(object ?? {}).sort();

test("/rmeta: the configured chain runs over the list, the content among its keys", async () => {
  await withServer(filters([include("Content-Type", "tk:content")]), async (base) => {
    const [only, ...rest] = await records(await put(base, "/rmeta", json));
    assert.equal(rest.length, 0);
    assert.deepEqual(keys(only), ["Content-Type", "tk:content"]);
    assert.match(String(only?.["tk:content"]), /Hello filters/);
    assert.match(String(only?.["Content-Type"]), /^text\/plain/);
  });
});

test("/rmeta: a filter that takes the document out of the list leaves an empty list", async () => {
  await withServer(filters([removeMime("text/plain")]), async (base) => {
    assert.deepEqual(await records(await put(base, "/rmeta", json)), []);
  });
});

test("/rmeta/{handler}: the chain runs for every handler", async () => {
  await withServer(filters([exclude("tk:content")]), async (base) => {
    for (const handler of ["text", "html", "xml"]) {
      const [only] = await records(await put(base, `/rmeta/${handler}`, json));
      assert.equal(only?.["tk:content"], undefined, handler);
      assert.match(String(only?.["Content-Type"]), /^text\/plain/);
    }
  });
});

test("without a chain, or with an empty or no-op one, /rmeta answers as before", async () => {
  const before = await withServer(undefined, async (base) => keys((await records(await put(base, "/rmeta", json)))[0]));
  assert.ok(before.length > 3 && before.includes("tk:content"));
  for (const none of [filters(), filters([{ name: "no-op-filter" }]), filters([], [{ name: "no-op-filter" }])]) {
    await withServer(none, async (base) => assert.deepEqual(keys((await records(await put(base, "/rmeta", json)))[0]), before));
  }
});

test("/meta: the chain runs over the metadata, as JSON and as CSV", async () => {
  await withServer(filters([include("Content-Type")]), async (base) => {
    const meta = await record(await put(base, "/meta", json));
    assert.deepEqual(Object.keys(meta), ["Content-Type"]);
    const csv = await put(base, "/meta", { Accept: "text/csv" });
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /^"?Content-Type"?,/);
  });
});

test("/meta/{field}: a field the chain left is answered, one it took out is 404", async () => {
  // A field the document has without the chain, so that the 404 is the chain's.
  const other = await withServer(undefined, async (base) => {
    const meta = await record(await put(base, "/meta", json));
    const name = Object.keys(meta).find((key) => key !== "Content-Type");
    assert.ok(name !== undefined, "an unfiltered document has more than its media type");
    assert.equal((await put(base, `/meta/${name}`, { Accept: "text/plain" })).status, 200);
    return name;
  });
  await withServer(filters([include("Content-Type")]), async (base) => {
    const kept = await put(base, "/meta/Content-Type", { Accept: "text/plain" });
    assert.equal(kept.status, 200);
    assert.match(await kept.text(), /^text\/plain/);
    const lost = await put(base, `/meta/${other}`, { Accept: "text/plain" });
    assert.equal(lost.status, 404);
    assert.match(await lost.text(), /Failed to get metadata field/);
  });
});

test("/meta: a filter that takes the document out of the list leaves no metadata", async () => {
  await withServer(filters([removeMime("text/plain")]), async (base) => {
    assert.deepEqual(await record(await put(base, "/meta", json)), {});
    assert.equal((await put(base, "/meta/Content-Type", { Accept: "text/plain" })).status, 404);
  });
});

test("/tika/json: the chain runs over the one object, which has the content and the handler", async () => {
  await withServer(filters([include("tk:content", "tk:content-handler-type")]), async (base) => {
    const document = await record(await put(base, "/tika/json", json));
    assert.deepEqual(keys(document), ["tk:content", "tk:content-handler-type"]);
    assert.match(String(document["tk:content"]), /Hello filters/);
    assert.equal(document["tk:content-handler-type"], "TEXT");
  });
  await withServer(filters([removeMime("text/plain")]), async (base) => {
    assert.deepEqual(await record(await put(base, "/tika/json", json)), {});
  });
});

test("/tika?handler=meta and ?handler=json: ripstream's own answers take the chain too", async () => {
  await withServer(filters([include("Content-Type", "tk:content")]), async (base) => {
    assert.deepEqual(Object.keys(await record(await put(base, "/tika?handler=meta", json))), ["Content-Type"]);
    const document = await record(await put(base, "/tika?handler=json", json));
    assert.deepEqual(Object.keys(document).sort(), ["metadata", "text"]);
    assert.deepEqual(Object.keys(document.metadata as object), ["Content-Type"]);
    assert.match(String(document.text), /Hello filters/);
  });
  await withServer(filters([exclude("tk:content")]), async (base) => {
    const document = await record(await put(base, "/tika?handler=json", json));
    assert.equal(document.text, "", "the content is tk:content for the chain");
  });
});

test("the text routes: the configured chain is not consulted, the parse-context chain is", async () => {
  await withServer(filters([exclude("tk:content")]), async (base) => {
    for (const path of ["/tika", "/tika/text", "/tika/html"]) {
      const response = await put(base, path);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /Hello filters/, path);
    }
  });
  await withServer(filters([], [exclude("tk:content")]), async (base) => {
    for (const path of ["/tika", "/tika/text"]) {
      const response = await put(base, path);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), "", path);
    }
  });
  await withServer(filters([], [removeMime("text/plain")]), async (base) => {
    assert.equal(await (await put(base, "/tika/text")).text(), "");
  });
  await withServer(filters([], [include("tk:content")]), async (base) => {
    assert.match(await (await put(base, "/tika/text")).text(), /Hello filters/);
  });
});

test("a parse-context chain stands in for the configured one on the JSON routes, as Tika's EmitHandler picks it", async () => {
  await withServer(filters([include("Content-Type")], [include("tk:content")]), async (base) => {
    assert.deepEqual(keys((await records(await put(base, "/rmeta", json)))[0]), ["tk:content"]);
  });
});

test("without a chain the text routes are what they were", async () => {
  const before = await withServer(undefined, async (base) => await (await put(base, "/tika/text")).text());
  assert.equal(before, "Hello filters\n");
  for (const none of [filters(), filters([exclude("tk:content")])]) {
    await withServer(none, async (base) => assert.equal(await (await put(base, "/tika/text")).text(), before));
  }
});

const inner = storedZip({ "c/inner.txt": "inner text" });
const container = storedZip({ "a.txt": "first document", "inner/bundle.zip": inner });

test("/unpack: rmeta.json is the filtered list, and the package still holds every document's bytes", async () => {
  await withServer(filters([include("Content-Type", "tk:content")]), async (base) => {
    const response = await put(base, "/unpack", {}, container);
    assert.equal(response.status, 200);
    const entries = readZip(new Uint8Array(await response.arrayBuffer()));
    const rmeta = JSON.parse(entries[1]!.data.toString("utf8")) as Array<Record<string, unknown>>;
    assert.ok(rmeta.length > 1);
    for (const each of rmeta) for (const key of Object.keys(each)) assert.ok(["Content-Type", "tk:content"].includes(key), key);
    const unpacked = entries.filter((entry) => entry.name.startsWith("unpacked/"));
    assert.ok(unpacked.length >= 2, entries.map((entry) => entry.name).join(", "));
    const manifest = JSON.parse(entries[0]!.data.toString("utf8")) as { resources: Array<{ path: string; bytes: number }> };
    assert.equal(manifest.resources[0]?.bytes, entries[1]!.data.length, "the manifest describes the filtered rmeta.json");
  });
});

test("/unpack: a filter that strips the embedded ids leaves the bytes with their documents", async () => {
  await withServer(filters([exclude("tk:embedded-id", "tk:embedded-id-path", "tk:embedded-depth")]), async (base) => {
    const plain = await withServer(undefined, async (inner) => readZip(new Uint8Array(await (await put(inner, "/unpack", {}, container)).arrayBuffer())));
    const response = await put(base, "/unpack", {}, container);
    const entries = readZip(new Uint8Array(await response.arrayBuffer()));
    assert.deepEqual(
      entries.filter((entry) => entry.name.startsWith("unpacked/")).map((entry) => [entry.name, entry.data.toString("utf8")]),
      plain.filter((entry) => entry.name.startsWith("unpacked/")).map((entry) => [entry.name, entry.data.toString("utf8")]),
    );
    const rmeta = JSON.parse(entries[1]!.data.toString("utf8")) as Array<Record<string, unknown>>;
    for (const each of rmeta) assert.equal(each["tk:embedded-id"], undefined);
  });
});

test("a blank text has no tk:content for a parse-context chain to drop, so it is answered as it was", async () => {
  const blank = "  \n";
  const before = await withServer(undefined, async (base) => await (await put(base, "/tika/text", {}, blank)).text());
  assert.notEqual(before, "", "the unfiltered answer is not empty, or this would prove nothing");
  await withServer(filters([], [exclude("tk:content")]), async (base) => {
    assert.equal(await (await put(base, "/tika/text", {}, blank)).text(), before);
  });
});

test("/pipes: the filters of the settings run on what the emitter writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-server-filters-pipes-"));
  try {
    const input = join(directory, "in");
    mkdirSync(input);
    writeFileSync(join(input, "a.txt"), "content of a");
    const written = async (extra: Record<string, unknown>, name: string): Promise<Array<Record<string, unknown>>> => {
      const output = join(directory, name);
      const settings = loadConfig({
        fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
        emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", onExists: "REPLACE" } } },
        pipes: { parseMode: "RMETA" },
        ...extra,
      }).pipes!;
      const instance = createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, authenticate: () => true, pipes: { settings } });
      const port = await instance.listen();
      try {
        const tuple = { id: "a.txt", fetcher: "fsf", fetchKey: "a.txt", emitter: "fse" };
        const response = await fetch(`http://127.0.0.1:${port}/pipes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tuple) });
        assert.equal(response.status, 200, await response.clone().text());
        return JSON.parse(readFileSync(join(output, "a.txt.json"), "utf8")) as Array<Record<string, unknown>>;
      } finally {
        await instance.close();
      }
    };
    const filtered = await written({ "metadata-filters": [{ "include-field-metadata-filter": { include: ["Content-Type", "tk:content"] } }] }, "filtered");
    assert.deepEqual(keys(filtered[0]), ["Content-Type", "tk:content"]);
    assert.ok(keys((await written({}, "plain"))[0]).length > 2, "without filters the list is what the parse made");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The language filter of the settings: /pipes and /async build their chains from `pipes.settings`, with the detector the
// server was given, and Tika's own CharSoup when it was given none.

const ENGLISH = "Scientists have discovered a new species of butterfly in the tropical rainforests of South America.";

const LANGUAGE_TUPLE = { id: "a.txt", fetcher: "fsf", fetchKey: "a.txt", emitter: "fse" };

function languageSettings(directory: string, output: string, maxLength?: number) {
  const input = join(directory, "in");
  mkdirSync(input, { recursive: true });
  writeFileSync(join(input, "a.txt"), ENGLISH);
  return loadConfig({
    fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
    emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", onExists: "REPLACE" } } },
    pipes: { parseMode: "RMETA" },
    "metadata-filters": [{ "charsoup-metadata-filter": maxLength === undefined ? {} : { maxLength } }],
  }).pipes!;
}

const fakeIdentifier: LanguageIdentifier = { identify: () => ({ language: "xyz", confidence: "LOW", rawScore: 0.5 }) };

async function waitFor(file: string): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`${file} was never written`);
}

test("/pipes: the language filter of the settings runs with Tika's CharSoup unless the server is given another detector", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-server-language-"));
  try {
    for (const [name, services, language, confidence] of [
      ["default", undefined, "eng", "HIGH"],
      ["given", { languageIdentifier: fakeIdentifier }, "xyz", "LOW"],
    ] as const) {
      const output = join(directory, name);
      const instance = createRipstreamServer({
        ripstream: createRipstream(),
        log: () => undefined,
        authenticate: () => true,
        pipes: { settings: languageSettings(directory, output) },
        ...(services === undefined ? {} : { metadataFilterServices: services }),
      });
      const port = await instance.listen();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/pipes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(LANGUAGE_TUPLE) });
        assert.equal(response.status, 200, await response.clone().text());
        const [record] = JSON.parse(readFileSync(join(output, "a.txt.json"), "utf8")) as Array<Record<string, unknown>>;
        assert.equal(record?.["tk:detected-language"], language, name);
        assert.equal(record?.["tk:detected-language-confidence"], confidence, name);
      } finally {
        await instance.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/async: the language filter of the settings runs on what the background run emits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-server-language-async-"));
  try {
    const output = join(directory, "out");
    const instance = createRipstreamServer({
      ripstream: createRipstream(),
      log: () => undefined,
      authenticate: () => true,
      pipes: { settings: languageSettings(directory, output, 5_000) },
    });
    const port = await instance.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/async`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tuples: [LANGUAGE_TUPLE] }) });
      assert.equal(response.status, 200, await response.clone().text());
      const [record] = JSON.parse(await waitFor(join(output, "a.txt.json"))) as Array<Record<string, unknown>>;
      assert.equal(record?.["tk:detected-language"], "eng");
    } finally {
      await instance.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a server whose settings name the language filter and whose services have no identifier does not start", () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-server-language-refused-"));
  try {
    const settings = languageSettings(directory, join(directory, "out"));
    assert.throws(
      () => createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, authenticate: () => true, pipes: { settings }, metadataFilterServices: {} }),
      /"charsoup-metadata-filter" needs a language identifier/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
