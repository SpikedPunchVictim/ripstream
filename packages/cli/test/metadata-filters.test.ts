import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type CliIO } from "../src/main.ts";

/*
 * `metadata-filters` in --config (tikajs-68os.9.2.6) through the commands that read one, with the real parsers: Apache
 * Tika's own test_recursive_embedded.docx (vendored unmodified in packages/bundle-standard/test/fixtures/tika) has
 * embedded documents. Tika's CLI runs the top-level chain over the recursive JSON it writes, and nowhere else; the
 * server and the pipes run it on every emit.
 */

const DOCX_PATH = fileURLToPath(new URL("../../bundle-standard/test/fixtures/tika/test_recursive_embedded.docx", import.meta.url));
const OFF = { isolation: { mode: "off" } };
const INCLUDE = { "metadata-filters": [{ "include-field-metadata-filter": { include: ["Content-Type", "tk:content"] } }] };

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (value) => out.push(value), stderr: (value) => err.push(value), readStdin: async () => new Uint8Array() };
}

async function withConfig<T>(config: unknown, run: (file: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-filters-"));
  const file = join(directory, "config.json");
  writeFileSync(file, JSON.stringify(config));
  try {
    return await run(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Records = Array<Record<string, unknown>>;

async function recursive(config: unknown, ...flags: string[]): Promise<{ readonly records: Records; readonly text: string }> {
  return await withConfig(config, async (file) => {
    const sink = io();
    assert.equal(await main(["--recursive", ...flags, "--config", file, DOCX_PATH], sink, { env: {} }), 0, sink.err.join(""));
    const text = sink.out.join("");
    const records = flags.includes("jsonl")
      ? text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      : (JSON.parse(text) as Records);
    return { records, text };
  });
}

const keysOf = (records: Records): string[][] => records.map((record) => Object.keys(record).sort());

test("--recursive json: clear-by-attachment-type empties the embedded documents the parsers typed, and keeps the rest", async () => {
  // test_recursive_embedded.docx holds an OLE object (an ATTACHMENT, by its oleObject relationship) and an EMF picture
  // (INLINE, by its image relationship), in that order.
  const clearing = (type: string) => ({ ...OFF, "metadata-filters": [{ "clear-by-attachment-type-metadata-filter": { types: [type] } }] });
  const inline = (await recursive(clearing("INLINE"))).records;
  assert.equal(inline.length, 3);
  assert.ok(Object.keys(inline[0]!).length > 2, "the container has no type, so it is kept");
  assert.equal(inline[1]!["tk:embedded-resource-type"], "ATTACHMENT");
  assert.deepEqual(Object.keys(inline[2]!), [], "the INLINE picture is emptied but still listed");
  const attachment = (await recursive(clearing("ATTACHMENT"))).records;
  assert.equal(attachment.length, 3);
  assert.deepEqual(Object.keys(attachment[1]!), [], "the ATTACHMENT object is emptied but still listed");
  assert.equal(attachment[2]!["tk:embedded-resource-type"], "INLINE");
});

test("--recursive json: the configured chain runs over every document", async () => {
  const { records } = await recursive({ ...OFF, ...INCLUDE });
  assert.ok(records.length > 1, "the document has embedded documents");
  for (const record of records) {
    for (const key of Object.keys(record)) assert.ok(["Content-Type", "tk:content"].includes(key), `${key} was filtered out`);
    assert.equal(typeof record["Content-Type"], "string");
  }
  assert.match(String(records[0]?.["tk:content"]), /embed/i, "the content is a key of the list, so the chain keeps it");
});

test("--recursive jsonl: the chain runs there too, one filtered document a line", async () => {
  const { records } = await recursive({ ...OFF, ...INCLUDE }, "-o", "jsonl");
  assert.ok(records.length > 1);
  for (const record of records) for (const key of Object.keys(record)) assert.ok(["Content-Type", "tk:content"].includes(key));
});

test("--recursive: a filter that takes documents out of the list takes them out of the output", async () => {
  const everything = await recursive(OFF);
  const baseType = (record: Record<string, unknown>): string => String(record["Content-Type"]).split(";")[0]!.trim().toLowerCase();
  const mimes = [...new Set(everything.records.slice(1).map(baseType))];
  assert.ok(mimes.length > 0);
  const removed = await recursive({ ...OFF, "metadata-filters": [{ "remove-by-mime-metadata-filter": { mimes: [mimes[0]] } }] });
  assert.ok(removed.records.length < everything.records.length);
  for (const record of removed.records) assert.notEqual(baseType(record), mimes[0]);
});

test("--recursive: no chain, or an empty one, writes what it wrote before the feature", async () => {
  const none = await recursive(OFF);
  const empty = await recursive({ ...OFF, "metadata-filters": [] });
  const noop = await recursive({ ...OFF, "metadata-filters": ["no-op-filter"] });
  assert.deepEqual(keysOf(empty.records), keysOf(none.records));
  assert.deepEqual(keysOf(noop.records), keysOf(none.records));
  assert.ok(keysOf(none.records).every((keys) => keys.length > 2), "an unfiltered document has more than the two filtered keys");
});

test("--recursive: only the top-level chain runs, as Tika's CLI loads only that one", async () => {
  const parseContext = { "parse-context": { "metadata-filters": [{ "include-field-metadata-filter": { include: ["Content-Type"] } }] } };
  const plain = await recursive(OFF);
  const { records } = await recursive({ ...OFF, ...parseContext });
  assert.deepEqual(keysOf(records), keysOf(plain.records));
});

test("the other commands do not run the chain: Tika's CLI filters the recursive JSON alone", async () => {
  await withConfig({ ...OFF, ...INCLUDE }, async (file) => {
    const metadata = io();
    assert.equal(await main(["metadata", "--json", "--config", file, DOCX_PATH], metadata, { env: {} }), 0, metadata.err.join(""));
    assert.ok(Object.keys(JSON.parse(metadata.out.join("")) as object).length > 2);
    const text = io();
    assert.equal(await main(["--config", file, DOCX_PATH], text, { env: {} }), 0, text.err.join(""));
    assert.match(text.out.join(""), /embed/i);
  });
});

test("a chain that cannot be built is a usage error, before anything is parsed", async () => {
  await withConfig({ ...OFF, "metadata-filters": ["no-such-metadata-filter"] }, async (file) => {
    const sink = io();
    assert.equal(await main(["--recursive", "--config", file, DOCX_PATH], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /metadata-filters/);
    assert.equal(sink.out.join(""), "");
  });
});

test("pipes: the chain runs on what the emitter writes, RMETA and CONTENT_ONLY", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-filters-pipes-"));
  try {
    const input = join(directory, "in");
    mkdirSync(input);
    writeFileSync(join(input, "a.txt"), "content of a");
    const run = async (parseMode: string, extra: Record<string, unknown>): Promise<string> => {
      const output = join(directory, `out-${parseMode}-${Object.keys(extra).length}`);
      const config = join(directory, `config-${parseMode}-${Object.keys(extra).length}.json`);
      writeFileSync(
        config,
        JSON.stringify({
          ...OFF,
          fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
          emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", onExists: "REPLACE" } } },
          "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
          pipes: { parseMode, numClients: 1 },
          ...extra,
        }),
      );
      const sink = io();
      assert.equal(await main(["pipes", "--config", config], sink), 0, sink.err.join(""));
      return readFileSync(join(output, "a.txt.json"), "utf8");
    };
    const filtered = JSON.parse(await run("RMETA", INCLUDE)) as Records;
    assert.deepEqual(Object.keys(filtered[0]!).sort(), ["Content-Type", "tk:content"]);
    const unfiltered = JSON.parse(await run("RMETA", {})) as Records;
    assert.ok(Object.keys(unfiltered[0]!).length > 2);
    // CONTENT_ONLY has its own default, so the top-level chain is not consulted: a chain that drops the content leaves it.
    const dropContent = { "metadata-filters": [{ "exclude-field-metadata-filter": { exclude: ["tk:content"] } }] };
    assert.equal((await run("CONTENT_ONLY", dropContent)).trim(), "content of a");
    const dropped = JSON.parse(await run("RMETA", dropContent)) as Records;
    assert.equal(dropped[0]!["tk:content"], undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function serving<T>(config: unknown, run: (base: string) => Promise<T>): Promise<T> {
  return await withConfig(config, async (file) => {
    const sink = io();
    const exit = main(["serve", "--port", "0", "--config", file], sink, { env: {} });
    for (let attempt = 0; attempt < 500 && !/http:\/\/127\.0\.0\.1:\d+/.test(sink.out.join("")); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    const base = `http://127.0.0.1:${/http:\/\/127\.0\.0\.1:(\d+)/.exec(sink.out.join(""))?.[1]}`;
    try {
      return await run(base);
    } finally {
      process.emit("SIGTERM");
      assert.equal(await exit, 0);
    }
  });
}

test("serve: the chain runs on /rmeta, /meta and /tika/json, and the text routes answer as before", async () => {
  const server = { server: { endpoints: ["meta", "rmeta", "tika"] } };
  await serving({ ...server, ...INCLUDE }, async (base) => {
    const body = readFileSync(DOCX_PATH);
    const headers = { "Content-Type": "application/octet-stream", Accept: "application/json" };
    const rmeta = (await (await fetch(`${base}/rmeta`, { method: "PUT", body, headers })).json()) as Records;
    assert.ok(rmeta.length > 1);
    for (const record of rmeta) for (const key of Object.keys(record)) assert.ok(["Content-Type", "tk:content"].includes(key));
    const meta = (await (await fetch(`${base}/meta`, { method: "PUT", body, headers })).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(meta), ["Content-Type"], "/meta has no content, and the chain keeps the media type");
    const json = (await (await fetch(`${base}/tika/json`, { method: "PUT", body, headers })).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(json).sort(), ["Content-Type", "tk:content"]);
    const text = await fetch(`${base}/tika`, { method: "PUT", body, headers: { ...headers, Accept: "text/plain" } });
    assert.equal(text.status, 200);
    assert.match(await text.text(), /embed/i);
  });
});

test("serve: without a chain the answers are the ones the server gave before", async () => {
  await serving({ server: { endpoints: ["rmeta"] } }, async (base) => {
    const body = readFileSync(DOCX_PATH);
    const rmeta = (await (await fetch(`${base}/rmeta`, { method: "PUT", body, headers: { "Content-Type": "application/octet-stream", Accept: "application/json" } })).json()) as Records;
    assert.ok(Object.keys(rmeta[0]!).length > 2);
    assert.ok("tk:embedded-depth" in rmeta[0]!);
  });
});
