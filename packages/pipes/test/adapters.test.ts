import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CompositeEmitter,
  CsvFetcher,
  JsonFetcher,
  JsonlEmitter,
  MemoryEmitter,
} from "../src/index.ts";

async function collect(fetcher: { fetch(): AsyncIterable<{ id: string; data: Uint8Array }> }) {
  const result: string[] = [];
  for await (const document of fetcher.fetch()) {
    result.push(new TextDecoder().decode(document.data));
  }
  return result;
}

test("CSV and JSON iterators yield records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-adapters-"));
  try {
    const csv = join(directory, "data.csv");
    writeFileSync(csv, "name,age\nAda,36\nGrace,45\n");
    assert.deepEqual(await collect(new CsvFetcher(csv)), ["Ada,36", "Grace,45"]);

    const json = join(directory, "data.json");
    writeFileSync(json, JSON.stringify([{ a: 1 }, { b: 2 }]));
    assert.deepEqual(await collect(new JsonFetcher(json)), ['{"a":1}', '{"b":2}']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("JSONL and composite emitters write documents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-emit-"));
  try {
    const path = join(directory, "out.jsonl");
    const memory = new MemoryEmitter();
    const emitter = new CompositeEmitter([new JsonlEmitter(path), memory]);
    await emitter.emit({ id: "a", text: "hello" });
    await emitter.close?.();
    assert.match(readFileSync(path, "utf8"), /"id":"a"/);
    assert.equal(memory.documents.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
