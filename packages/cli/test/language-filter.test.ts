import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, type CliIO } from "../src/main.ts";

/*
 * `charsoup-metadata-filter` in --config (tikajs-68os.9.3.2) through the commands that run a chain, with Tika's own
 * language model: the three `tk:detected-language*` keys come out of --recursive, pipes and the server's /rmeta.
 */

const OFF = { isolation: { mode: "off" } };
const LANGUAGE = { "metadata-filters": [{ "charsoup-metadata-filter": {} }] };
const ENGLISH = "Scientists have discovered a new species of butterfly in the tropical rainforests of South America.";
const FRENCH = "La République française est une démocratie laïque dont la devise est Liberté, Égalité, Fraternité.";

type Records = Array<Record<string, unknown>>;

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (value) => out.push(value), stderr: (value) => err.push(value), readStdin: async () => new Uint8Array() };
}

async function scratch<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-language-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function configIn(directory: string, config: unknown): string {
  const file = join(directory, "config.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

/** The three keys as a detector's verdict: language, the confidence's name, and a score that reads as a Java double. */
function assertVerdict(record: Record<string, unknown> | undefined, language: string): void {
  assert.equal(record?.["tk:detected-language"], language);
  assert.equal(record?.["tk:detected-language-confidence"], "HIGH");
  const raw = String(record?.["tk:detected-language-confidence-raw"]);
  assert.match(raw, /^0\.\d+$/);
  assert.ok(Number(raw) > 0.9 && Number(raw) <= 1, raw);
}

test("--recursive: the language of a document is written to it, from Tika's model", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "english.txt"), ENGLISH);
    writeFileSync(join(directory, "french.txt"), FRENCH);
    const config = configIn(directory, { ...OFF, ...LANGUAGE });
    for (const [name, language] of [["english.txt", "eng"], ["french.txt", "fra"]] as const) {
      const sink = io();
      assert.equal(await main(["--recursive", "--config", config, join(directory, name)], sink, { env: {} }), 0, sink.err.join(""));
      const records = JSON.parse(sink.out.join("")) as Records;
      assertVerdict(records[0], language);
    }
  });
});

test("--recursive jsonl carries the keys too", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "english.txt"), ENGLISH);
    const sink = io();
    assert.equal(await main(["--recursive", "-o", "jsonl", "--config", configIn(directory, { ...OFF, ...LANGUAGE }), join(directory, "english.txt")], sink, { env: {} }), 0, sink.err.join(""));
    assertVerdict(JSON.parse(sink.out.join("").trim().split("\n")[0]!) as Record<string, unknown>, "eng");
  });
});

test("--recursive without the filter writes no language", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "english.txt"), ENGLISH);
    const sink = io();
    assert.equal(await main(["--recursive", "--config", configIn(directory, OFF), join(directory, "english.txt")], sink, { env: {} }), 0, sink.err.join(""));
    const [record] = JSON.parse(sink.out.join("")) as Records;
    assert.equal(record?.["tk:detected-language"], undefined);
  });
});

test("the filter's maxLength is read: a text cut short before its language shows is not detected", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "mixed.txt"), `1234567890 ${ENGLISH}`);
    const run = async (maxLength: number): Promise<Record<string, unknown> | undefined> => {
      const config = configIn(directory, { ...OFF, "metadata-filters": [{ "charsoup-metadata-filter": { maxLength } }] });
      const sink = io();
      assert.equal(await main(["--recursive", "--config", config, join(directory, "mixed.txt")], sink, { env: {} }), 0, sink.err.join(""));
      return (JSON.parse(sink.out.join("")) as Records)[0];
    };
    assert.equal((await run(100_000))?.["tk:detected-language"], "eng");
    const cut = await run(8);
    assert.equal(cut?.["tk:detected-language"], "");
    assert.equal(cut?.["tk:detected-language-confidence"], "NONE");
    assert.equal(cut?.["tk:detected-language-confidence-raw"], "0.0");
  });
});

test("a maxLength that reads nothing is a usage error, before anything is parsed", async () => {
  await scratch(async (directory) => {
    writeFileSync(join(directory, "english.txt"), ENGLISH);
    const config = configIn(directory, { ...OFF, "metadata-filters": [{ "charsoup-metadata-filter": { maxLength: 0 } }] });
    const sink = io();
    assert.equal(await main(["--recursive", "--config", config, join(directory, "english.txt")], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /"charsoup-metadata-filter": setting "maxLength" must be a whole number from 1 to 2147483647/);
    assert.equal(sink.out.join(""), "");
  });
});

test("pipes: the language is in what the emitter writes", async () => {
  await scratch(async (directory) => {
    const input = join(directory, "in");
    const output = join(directory, "out");
    mkdirSync(input);
    writeFileSync(join(input, "a.txt"), ENGLISH);
    const config = configIn(directory, {
      ...OFF,
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { fse: { "file-system-emitter": { basePath: output, fileExtension: "json", onExists: "REPLACE" } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      pipes: { parseMode: "RMETA", numClients: 1 },
      ...LANGUAGE,
    });
    const sink = io();
    assert.equal(await main(["pipes", "--config", config], sink), 0, sink.err.join(""));
    assertVerdict((JSON.parse(readFileSync(join(output, "a.txt.json"), "utf8")) as Records)[0], "eng");
  });
});

test("serve: /rmeta answers with the language", async () => {
  await scratch(async (directory) => {
    const config = configIn(directory, { ...OFF, server: { endpoints: ["rmeta"] }, ...LANGUAGE });
    const sink = io();
    const exit = main(["serve", "--port", "0", "--config", config], sink, { env: {} });
    for (let attempt = 0; attempt < 500 && !/http:\/\/127\.0\.0\.1:\d+/.test(sink.out.join("")); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    const base = `http://127.0.0.1:${/http:\/\/127\.0\.0\.1:(\d+)/.exec(sink.out.join(""))?.[1]}`;
    try {
      const response = await fetch(`${base}/rmeta`, {
        method: "PUT",
        body: ENGLISH,
        headers: { "Content-Type": "text/plain", Accept: "application/json" },
      });
      assert.equal(response.status, 200);
      assertVerdict(((await response.json()) as Records)[0], "eng");
    } finally {
      process.emit("SIGTERM");
      assert.equal(await exit, 0);
    }
  });
});
