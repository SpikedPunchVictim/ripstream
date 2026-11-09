import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test, type TestContext } from "node:test";
import { createDeflate } from "node:zlib";
import { MemoryPool, type PoolStats, type RunDiagnostics } from "@spikedpunch/ripstream-isolation-node";
import { LimitExceededError, MalformedDocumentError, httpStatusForError } from "../src/index.ts";
import { createStandardIsolation, type StandardIsolation } from "../src/isolation.ts";

/**
 * A PDF flate bomb through the REAL isolator. Since the PDF worker thread was removed, PdfParser runs pdf.js on the
 * calling thread, so the isolator's child process is the only thing standing between a hostile /FlateDecode stream
 * and the server process. The old in-parser test (a 96 MiB run of spaces, deflated, as a content stream) proved the
 * worker's memory budget; this file proves the same document is contained by the child instead.
 *
 * What is observed (macOS host, Darwin 25.3, Node 24, pdf.js on the child's main thread), and why the numbers below are what
 * they are:
 *
 *   - The inflated bytes live in a typed array, which is OFF the V8 heap. The heap cap (L1, --max-old-space-size)
 *     never fires for this bomb; the layer that ends it is the parent's RSS poll (L3), which SIGKILLs the child's
 *     process group once its resident set passes `perChildMb`. The classifier turns that kill into a
 *     LimitExceededError ("... exceeded its memory limit (resident set size)", code LIMIT_EXCEEDED, HTTP 422).
 *     `heapMb` is still set small below so that, on a platform where the child dies of V8's own heap limit or an
 *     address-space cap first (Linux has RLIMIT_AS and a 20 ms /proc poll), the answer is the same class and code
 *     ("Isolated parser ran out of memory"); this file accepts either wording, never a "malformed" or a timeout.
 *   - Weaker layers on macOS: the RSS poll is the `ps` poll (250 ms; the child's RSS rose up to ~130 MiB between two
 *     polls) and there is no RLIMIT_AS. Neither changes the outcome here, only how far past the cap the child gets
 *     (observed peak 350 - 360 MiB against a 256 MiB cap).
 *   - Sizing: the default child budget (1536 MiB) does NOT contain a 2 GiB-inflated bomb by killing it: pdf.js
 *     inflated it in 13 s with a 1.37 GiB peak RSS and answered with empty text, which is within the budget by
 *     design. A bomb that exceeds the defaults is a 13+ s test with a ~1.4 GiB child, so this file uses tight
 *     limits instead: perChildMb 256, heapMb 64, and a bomb of 1 GiB inflated (~1 MB on the wire), 4 times the cap.
 *     The 1 GiB is deliberate head-room: it makes "the child finished before the RSS poll noticed" impossible (the
 *     2 GiB case took 13 s to inflate, so 1 GiB takes several seconds; the poll runs every 250 ms on macOS).
 *     The whole file runs in about 5 s: ~2.5 s to build the bomb, ~1 s for the kill, ~1 s per child boot and parse.
 */

const MIB = 1024 * 1024;

const CONFIG = { mode: "strict", perChildMb: 256, heapMb: 64, maxTaskMillis: 20_000 } as const;
const BOMB_INFLATED_MB = 1024;

// ---- fixtures, built by hand -----------------------------------------------------------------------------------------

/** The old test's `rawPdf`: objects, a trailer, no xref (pdf.js recovers the objects by scanning). */
function rawPdf(objects: readonly string[]): Uint8Array {
  const body = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`);
  return Buffer.from(`%PDF-1.4\n${body.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

/**
 * `inflatedMb` MiB of spaces, deflated. Streamed through zlib in 8 MiB pieces so that building the bomb never holds the
 * inflated bytes (the parent's RSS is measured around the parse, and a 1 GiB buffer here would swamp it).
 */
async function deflateSpaces(inflatedMb: number): Promise<Buffer> {
  const piece = Buffer.alloc(8 * MIB, 0x20);
  async function* pieces(): AsyncGenerator<Buffer> {
    for (let sent = 0; sent < inflatedMb; sent += 8) yield piece;
  }
  const out: Buffer[] = [];
  await pipeline(Readable.from(pieces(), { objectMode: false }), createDeflate({ level: 9 }), async (deflated) => {
    for await (const chunk of deflated) out.push(chunk as Buffer);
  });
  return Buffer.concat(out);
}

/** One page whose only content stream is `inflatedMb` MiB of spaces, /FlateDecode. The same structure at any size. */
async function flatePdf(inflatedMb: number): Promise<Uint8Array> {
  const deflated = await deflateSpaces(inflatedMb);
  return rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] /Contents 4 0 R >>",
    `<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${deflated.toString("latin1")}\nendstream`,
  ]);
}

/** A one-page PDF with standard Helvetica text and a real xref (ASCII only, so string length is byte length). */
function helloPdf(text: string): Uint8Array {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---- harness ---------------------------------------------------------------------------------------------------------

/** Built once, used by the one test that needs it. */
let bomb: Promise<Uint8Array> | undefined;
const theBomb = (): Promise<Uint8Array> => (bomb ??= flatePdf(BOMB_INFLATED_MB));

interface Harness {
  readonly standard: StandardIsolation;
  readonly pool: MemoryPool;
  /** One entry per child run, in order. */
  readonly runs: RunDiagnostics[];
}

/** A fresh pool and isolator per test, so the pool numbers asserted below belong to that test alone. */
async function withIsolator(action: (harness: Harness) => Promise<void>): Promise<void> {
  const pool = new MemoryPool({ poolMb: 4096, maxQueue: 4 });
  const runs: RunDiagnostics[] = [];
  const standard = await createStandardIsolation({
    config: CONFIG,
    pool,
    runner: { onRunSettled: (d) => runs.push(d) },
  });
  try {
    await action({ standard, pool, runs });
  } finally {
    await standard.isolator.dispose();
    pool.dispose();
  }
}

/**
 * The runner returns a child's pool lease when the child is DEAD, which can be a moment after its caller was answered
 * (unreapedChildren counts exactly that gap). A killed child is reaped before the caller is answered, so this normally
 * returns on the first look; the wait only keeps a slow CI box from being a false alarm. A leak never settles.
 */
async function settledStatus(standard: StandardIsolation): Promise<{ pool: PoolStats; unreapedChildren: number }> {
  const deadline = performance.now() + 5000;
  for (;;) {
    const { pool, unreapedChildren } = standard.isolator.status();
    assert.ok(pool !== null, "an isolating isolator reports its pool");
    if ((pool.freeMb === pool.poolMb && unreapedChildren === 0) || performance.now() > deadline) {
      return { pool, unreapedChildren };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function assertPoolReleased(status: { pool: PoolStats; unreapedChildren: number }): void {
  assert.deepEqual(
    { freeMb: status.pool.freeMb, reservedMb: status.pool.reservedMb, running: status.pool.running, queued: status.pool.queued },
    { freeMb: status.pool.poolMb, reservedMb: 0, running: 0, queued: 0 },
    "every MiB the bomb's child reserved is back in the pool",
  );
  assert.equal(status.unreapedChildren, 0, "no child is left unreaped");
}

// ---- tests -----------------------------------------------------------------------------------------------------------

test("control: the same PDF structure with a small flate stream parses in a child and takes no memory path", async (t: TestContext) => {
  await withIsolator(async ({ standard, runs }) => {
    const tiny = await flatePdf(1);
    const answer = await standard.ripstream.parse(tiny, { filename: "small-stream.pdf" });
    assert.equal(answer.text.trim(), "", "a content stream of spaces paints no text");

    assert.equal(runs.length, 1, "it went to a child");
    const run = runs[0]!;
    assert.equal(run.terminal, "done");
    assert.equal(run.killReason, null);
    assert.equal(run.signal, null);
    t.diagnostic(`control child peak RSS ${String(run.rss?.peakMb.toFixed(0))} MiB against a ${CONFIG.perChildMb} MiB cap`);
    assert.ok((run.rss?.peakMb ?? 0) < CONFIG.perChildMb, "an ordinary small PDF stays under the same cap the bomb exceeds");
    assertPoolReleased(await settledStatus(standard));
  });
});

test("a PDF flate bomb ends as a typed LimitExceededError (422), is killed by memory not by time, and leaves the isolator serving", async (t: TestContext) => {
  const bytes = await theBomb();
  await withIsolator(async ({ standard, runs }) => {
    // Coarse sanity bound, not a measurement: RSS is noisy (allocator caching, GC timing). It only catches the
    // failure this test is about, the parent itself inflating the bomb (1 GiB inflated against a 600 MiB allowance).
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    let failure: unknown;
    try {
      await standard.ripstream.parse(bytes, { filename: "bomb.pdf" });
    } catch (error) {
      failure = error;
    }
    const elapsedMs = performance.now() - started;
    const rssAfter = process.memoryUsage().rss;

    // 1. A typed, HTTP-mappable failure: a memory limit, not a malformed document and not a crash.
    assert.ok(failure instanceof LimitExceededError, `expected a LimitExceededError, got ${String(failure)}`);
    assert.ok(!(failure instanceof MalformedDocumentError), "the PDF must not have failed as malformed");
    assert.equal(failure.code, "LIMIT_EXCEEDED");
    assert.match(failure.message, /memory/i);
    assert.equal(httpStatusForError(failure), 422);

    // 2. One child ran and it died of the memory path: the RSS poll (or, on other hosts, V8 / an address-space cap),
    //    never the wall clock and never an error frame about the document.
    assert.equal(runs.length, 1, "the bomb got exactly one child");
    const run = runs[0]!;
    t.diagnostic(
      `bomb ${bytes.length} bytes (${BOMB_INFLATED_MB} MiB inflated): ${failure.constructor.name} ${failure.code}: ${failure.message}; ` +
        `killReason ${String(run.killReason)}, signal ${String(run.signal)}, child peak RSS ${String(run.rss?.peakMb.toFixed(0))} MiB ` +
        `against a ${CONFIG.perChildMb} MiB cap; ${elapsedMs.toFixed(0)} ms; parent RSS ${(rssBefore / MIB).toFixed(0)} -> ${(rssAfter / MIB).toFixed(0)} MiB`,
    );
    assert.notEqual(run.killReason, "timeout", "ended by the memory limit, not the wall clock");
    assert.equal(run.terminal, null, "the child never got to answer");
    assert.equal(run.graceKilled, false);
    assert.equal(run.reaped, true, "the child was dead before its caller was answered");
    if (run.killReason === "rss") {
      assert.match(failure.message, /resident set size/);
      assert.ok((run.rss?.peakMb ?? 0) > CONFIG.perChildMb, "the kill came from the child passing its cap");
    }

    // 3. Bounded time: far inside the task budget.
    assert.ok(elapsedMs < CONFIG.maxTaskMillis, `took ${elapsedMs.toFixed(0)} ms of a ${CONFIG.maxTaskMillis} ms budget`);

    // 4. The parent did not grow (coarse sanity bound, see above).
    assert.ok(rssAfter - rssBefore < 600 * MIB, `parent RSS grew by ${((rssAfter - rssBefore) / MIB).toFixed(0)} MiB`);

    // 5. Nothing left behind: the pool is whole and no child is unreaped.
    assertPoolReleased(await settledStatus(standard));

    // 6. And the isolator still serves a normal request right away, in a new child.
    const answer = await standard.ripstream.parse(helloPdf("Served after the bomb"), { filename: "after.pdf" });
    assert.match(answer.text, /Served after the bomb/);
    assert.equal(runs.length, 2, "the follow-up got its own child");
    assert.equal(runs[1]!.terminal, "done");
    assert.equal(runs[1]!.killReason, null);
    assertPoolReleased(await settledStatus(standard));
  });
});
