import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, type CliIO } from "../src/main.ts";

/*
 * `--segments` (tikajs-xock): the segments of each record in the recursive output of `parse -r` and of `pipes`, as a
 * `tk:segments` string of JSON on the record's object. Without the flag the output is what it was.
 */

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (value) => out.push(value), stderr: (value) => err.push(value), readStdin: async () => new Uint8Array() };
}

const TEXT = "first line\nsecond line\n";

function scratch(run: (directory: string, file: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-segments-"));
  writeFileSync(join(directory, "a.txt"), TEXT);
  return run(directory, join(directory, "a.txt")).finally(() => rmSync(directory, { recursive: true, force: true }));
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly labels: readonly string[];
  readonly location: string;
}

function segmentsOf(object: Record<string, unknown>): Segment[] {
  assert.equal(typeof object["tk:segments"], "string");
  return JSON.parse(object["tk:segments"] as string) as Segment[];
}

test("parse -r --segments adds tk:segments to each document, offsets into its own tk:content", async () => {
  await scratch(async (_, file) => {
    const sink = io();
    assert.equal(await main(["parse", "-r", "--segments", file], sink, { env: {} }), 0, sink.err.join(""));
    const [object] = JSON.parse(sink.out.join("")) as Array<Record<string, unknown>>;
    const segments = segmentsOf(object!);
    assert.deepEqual(segments.map((segment) => segment.location), ["line=1", "line=2"]);
    assert.equal((object!["tk:content"] as string).slice(segments[1]!.start, segments[1]!.end), "second line");
  });
});

test("parse -r --segments -o jsonl carries it on each line", async () => {
  await scratch(async (_, file) => {
    const sink = io();
    assert.equal(await main(["parse", "-r", "--segments", "-o", "jsonl", file], sink, { env: {} }), 0, sink.err.join(""));
    const [line] = sink.out.join("").trim().split("\n");
    assert.equal(segmentsOf(JSON.parse(line!) as Record<string, unknown>).length, 2);
  });
});

test("without --segments the recursive output has no tk:segments and the same keys", async () => {
  await scratch(async (_, file) => {
    const keys = async (args: string[]): Promise<string[]> => {
      const sink = io();
      assert.equal(await main(args, sink, { env: {} }), 0, sink.err.join(""));
      return Object.keys((JSON.parse(sink.out.join("")) as Array<Record<string, unknown>>)[0]!).sort();
    };
    const off = await keys(["parse", "-r", file]);
    assert.equal(off.includes("tk:segments"), false);
    assert.deepEqual(await keys(["parse", "-r", "--segments", file]), [...off, "tk:segments"].sort());
  });
});

test("--segments is a usage error without --recursive and for a command that writes no records", async () => {
  await scratch(async (_, file) => {
    for (const args of [["parse", "--segments", file], ["metadata", "--segments", file], ["detect", "--segments", file], ["formats", "--segments"]]) {
      const sink = io();
      assert.equal(await main(args, sink, { env: {} }), 2, args.join(" "));
      assert.match(sink.err.join(""), /--segments applies to parse --recursive and pipes/, args.join(" "));
    }
  });
});

test("--segments is in --help", async () => {
  const sink = io();
  assert.equal(await main(["--help"], sink), 0);
  assert.match(sink.out.join(""), /--segments .*tk:segments/);
});

function pipesConfig(directory: string, parseMode: string): string {
  const input = join(directory, "in");
  mkdirSync(input, { recursive: true });
  writeFileSync(join(input, "a.txt"), TEXT);
  const config = join(directory, "tika-config.json");
  writeFileSync(
    config,
    JSON.stringify({
      fetchers: { fsf: { "file-system-fetcher": { basePath: input } } },
      emitters: { fse: { "file-system-emitter": { basePath: join(directory, "out"), fileExtension: "json", onExists: "REPLACE" } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: input, fetcherId: "fsf", emitterId: "fse" } },
      pipes: { parseMode, numClients: 1 },
    }),
  );
  return config;
}

test("pipes --segments writes tk:segments in the list the emitter writes, and without it nothing changes", async () => {
  await scratch(async (directory) => {
    const config = pipesConfig(directory, "RMETA");
    const written = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(directory, "out", "a.txt.json"), "utf8")) as Array<Record<string, unknown>>;
    const sink = io();
    assert.equal(await main(["pipes", "--config", config], sink, { env: {} }), 0, sink.err.join(""));
    assert.equal("tk:segments" in written()[0]!, false);
    const withSegments = io();
    assert.equal(await main(["pipes", "--config", config, "--segments"], withSegments, { env: {} }), 0, withSegments.err.join(""));
    assert.deepEqual(segmentsOf(written()[0]!).map((segment) => segment.location), ["line=1", "line=2"]);
  });
});

test("pipes --segments with a parse mode that writes no list of records is a usage error", async () => {
  await scratch(async (directory) => {
    const sink = io();
    assert.equal(await main(["pipes", "--config", pipesConfig(directory, "CONCATENATE"), "--segments"], sink, { env: {} }), 2);
    assert.match(sink.err.join(""), /--segments needs the parse mode RMETA or UNPACK/);
  });
});
