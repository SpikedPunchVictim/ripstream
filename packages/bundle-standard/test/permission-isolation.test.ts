import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MemoryPool } from "@spikedpunch/ripstream-isolation-node";
import type { Metadata, ParseRecord } from "../src/index.ts";
import { createStandardIsolation, type StandardIsolation } from "../src/isolation.ts";

/**
 * tikajs-bcnh: the real standard child under Node's permission model answers exactly as one without it, for a document of
 * each family it reads (office, PDF, archive, HTML, mail, CSV), as records so the embedded documents are compared too.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORPUS = [
  "packages/parsers/test/fixtures/segments/files/customers.docx",
  "packages/parsers/test/fixtures/segments/files/vendors.xlsx",
  "packages/parsers/test/fixtures/segments/files/deck.pptx",
  "packages/parsers/test/fixtures/repros/pdf-glyph-gaps.pdf",
  "packages/parsers/test/fixtures/paths/files/bundle-docx.zip",
  "packages/parsers/test/fixtures/xberg/html/files/formatting.html",
  "packages/parsers/test/fixtures/xberg/mail/files/fake-email-b64.eml",
  "packages/bundle-standard/test/fixtures/tika/test_recursive_embedded.docx",
].map((path) => join(ROOT, path));

const encoder = new TextEncoder();
const CSV = encoder.encode("name,city\nAda,London\nGrace,New York\n");

const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 8 });
const base = { config: { mode: "strict" }, pool, inProcessTypes: [] } as const;
const plain: StandardIsolation = await createStandardIsolation(base);
const launched: string[][] = [];
const confined: StandardIsolation = await createStandardIsolation({
  ...base,
  permission: true,
  runner: { spawnFn: (file, args, options) => (launched.push([...args]), spawn(file, args, options)) },
});
after(async () => {
  await Promise.all([plain.isolator.dispose(), confined.isolator.dispose()]);
  pool.dispose();
});

/** Core stamps each record with how long its parse took: the one key that cannot be equal across two runs. */
const TIMING_KEY = "tk:parse-time-millis";
const comparable = (metadata: Metadata): unknown =>
  [...metadata.names()].filter((name) => name !== TIMING_KEY).sort().map((name) => [name, [...metadata.getAll(name)]]);
const records = (list: readonly ParseRecord[]): unknown[] =>
  list.map((record) => ({
    content: record.content,
    path: record.embeddedResourcePath,
    type: String(record.mediaType),
    metadata: comparable(record.metadata),
    exception: record.exception === null ? null : record.exception.message,
  }));

for (const path of [...CORPUS, "inline.csv"]) {
  const name = path.split("/").pop()!;
  test(`${name}: the same records with permission as without`, { timeout: 120_000 }, async () => {
    const bytes = path === "inline.csv" ? CSV : readFileSync(path);
    const expected = records(await plain.ripstream.parseRecursive(bytes, { filename: name }));
    const actual = records(await confined.ripstream.parseRecursive(bytes, { filename: name }));
    assert.ok((expected[0] as { content: string }).content.length > 0, "the plain child read something");
    assert.deepEqual(actual, expected);
    assert.ok(launched.length > 0 && launched.every((args) => args.includes("--permission=true")), "every child was started under the model");
  });
}

test("a { path } input is refused under permission: the child cannot open it", async () => {
  await assert.rejects(confined.ripstream.parse({ path: CORPUS[0]! }, { filename: "customers.docx" }), /cannot open \{ path \} inputs/);
  assert.equal((await plain.ripstream.parse({ path: CORPUS[0]! }, { filename: "customers.docx" })).text.length > 0, true);
});
