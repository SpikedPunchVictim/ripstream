import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MemoryPool } from "@spikedpunch/ripstream-isolation-node";
import { LimitExceededError, type ParseRecord } from "../src/index.ts";
import { createStandardIsolation, type StandardIsolationOptions } from "../src/isolation.ts";
import { buildTextHeavyDocx, buildTextHeavyPdf, PDF_CHARS_PER_PAGE } from "./text-heavy.ts";

/**
 * Text-heavy documents through the real isolated child, with the child's limits scaled down so the test is fast.
 *
 * tikajs-m5ng: a 50 MB text PDF failed "Isolated parser ran out of memory" at the full output cap although the
 * container peaked at 884 MiB. Cause: pdf.js kept about 130 KiB of state per page it had served (13 bytes per
 * extracted character), so a 5,000-page PDF needed more than the 512 MiB heap before it reached its cap. The tests
 * here use the same shape at 1/30 the size and 1/3 of the heap.
 */

const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 4 });
after(() => pool.dispose());

async function withIsolation(
  overrides: Partial<StandardIsolationOptions>,
  action: (parse: (bytes: Uint8Array, maxOutputChars: number) => Promise<readonly ParseRecord[]>) => Promise<void>,
): Promise<void> {
  const standard = await createStandardIsolation({ config: { mode: "strict" }, pool, ...overrides });
  try {
    await action((bytes, maxOutputChars) =>
      standard.ripstream.parseRecursive(bytes, {
        limits: { maxOutputChars, maxEmbeddedResources: 1000 },
        onDocumentFailure: "record",
        onOutputLimit: "truncate",
      }),
    );
  } finally {
    await standard.isolator.dispose();
  }
}

// 1,000 pages is about 10.5 million characters: pdf.js held about 130 MiB for them before the fix (the heap needs 170 MiB)
// and about 40 MiB after (80 MiB).
const PAGES = 1000;
const SMALL_HEAP_MB = 128;

test("a 1,000-page text PDF reaches its text in a child with a 128 MiB heap (pdf.js releases per-page state)", async () => {
  const pdf = buildTextHeavyPdf(PAGES);
  await withIsolation({ config: { mode: "strict", perChildMb: 768, heapMb: SMALL_HEAP_MB } }, async (parse) => {
    const records = await parse(pdf, 12_000_000);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.exception, null);
    assert.ok((records[0]?.content.length ?? 0) > PAGES * PDF_CHARS_PER_PAGE * 0.8, `got ${records[0]?.content.length} characters`);
  });
});

test("text up to the output cap comes back as a partial result, with the flag, in the same small heap", async () => {
  const pdf = buildTextHeavyPdf(PAGES);
  await withIsolation({ config: { mode: "strict", perChildMb: 768, heapMb: SMALL_HEAP_MB } }, async (parse) => {
    const records = await parse(pdf, 5_000_000);
    assert.equal(records[0]?.content.length, 5_000_000);
    assert.equal(records[0]?.metadata.get("tk:exception:write-limit-reached"), "true");
  });
});

test("a child that runs out of heap says so, names heapMb and the child's resident memory", async () => {
  const pdf = buildTextHeavyPdf(PAGES);
  await withIsolation({ config: { mode: "strict", perChildMb: 768, heapMb: 48 } }, async (parse) => {
    await assert.rejects(parse(pdf, 12_000_000), (error: unknown) => {
      assert.ok(error instanceof LimitExceededError, String(error));
      assert.match(error.message, /V8 heap limit was reached \(heapMb 48 MiB; child resident set \d+ MiB at most, of its perChildMb 768 MiB\)/);
      assert.match(error.message, /raise heapMb/);
      return true;
    });
  });
});

test("a text-heavy DOCX reaches the cap under truncate in a small heap", async () => {
  const docx = buildTextHeavyDocx(60_000);
  await withIsolation({ config: { mode: "strict", perChildMb: 768, heapMb: SMALL_HEAP_MB } }, async (parse) => {
    const records = await parse(docx, 3_000_000);
    assert.equal(records[0]?.content.length, 3_000_000);
    assert.equal(records[0]?.metadata.get("tk:exception:write-limit-reached"), "true");
  });
});
