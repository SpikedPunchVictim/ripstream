import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTick } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { mock, test } from "node:test";
import {
  AbortError,
  BodyContentHandler,
  EmbeddedDocumentBytesHandler,
  CONTEXT_KEYS,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  ParseTimeoutError,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { PDFDocument } from "pdf-lib";
import { PdfParser } from "../src/index.ts";
import type { PdfParserOptions } from "../src/pdf.ts";
import { encryptedPdf, helloPdf, manyPagesPdf, samplePdf } from "./fixtures.ts";

interface Outcome {
  readonly error?: { readonly type: string; readonly message: string };
}

/** Parses `bytes` and reports the error the parse rejected with, if any. */
async function runParse(
  bytes: Uint8Array,
  options: PdfParserOptions,
  context = new ParseContext(),
  handler = new BodyContentHandler(),
): Promise<Outcome> {
  const stream = await RipstreamInputStream.from(bytes);
  try {
    await new PdfParser(options).parse(stream, handler, new Metadata(), context);
    return {};
  } catch (error) {
    assert.ok(error instanceof Error, "parse must reject with an Error");
    return { error: { type: error.constructor.name, message: error.message } };
  } finally {
    await stream.close();
  }
}

type ErrorClass = new (...args: never[]) => Error;

async function attachmentPdf(content: Uint8Array): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage();
  await document.attach(content, "note.txt", { mimeType: "text/plain" });
  return document.save();
}

/** The catalog lives in an object stream and the xref stream was cut off. */
async function lostXrefStream(): Promise<Uint8Array> {
  const bytes = await helloPdf(true);
  const xrefObject = bytes.lastIndexOf("/Type /XRef");
  return bytes.subarray(0, bytes.lastIndexOf("obj", xrefObject) - 8);
}

const text = (source: string): Uint8Array => new TextEncoder().encode(source);

test("hands attachment bytes to the embedded document extractor", async () => {
  const bytes = await attachmentPdf(text("attached text"));
  const resources = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const outcome = await runParse(bytes, {}, context);
  assert.equal(outcome.error, undefined);
  assert.equal(resources.resources.length, 1);
  assert.equal(new TextDecoder().decode(resources.resources[0]?.bytes), "attached text");
});

// Cancellation and timeouts ----------------------------------------------------

class AbortingHandler extends BodyContentHandler {
  readonly #onText: () => void;

  constructor(onText: () => void) {
    super();
    this.#onText = onText;
  }

  override async characters(ch: string, start: number, length: number): Promise<void> {
    this.#onText();
    await super.characters(ch, start, length);
  }
}

test("honours an already aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await runParse(
    new Uint8Array([1, 2, 3]),
    {},
    new ParseContext({ signal: controller.signal }),
  );
  assert.equal(outcome.error?.type, AbortError.name);
});

test("stops when aborted from the content handler", async () => {
  const controller = new AbortController();
  const outcome = await runParse(
    await manyPagesPdf(5),
    {},
    new ParseContext({ signal: controller.signal }),
    new AbortingHandler(() => controller.abort()),
  );
  assert.equal(outcome.error?.type, AbortError.name);
});

test("stops when aborted between pages", async () => {
  const controller = new AbortController();
  const outcome = await runParse(
    await manyPagesPdf(5),
    {},
    new ParseContext({ signal: controller.signal }),
    new AbortingHandler(() => {
      setImmediate(() => controller.abort());
    }),
  );
  assert.equal(outcome.error?.type, AbortError.name);
});

/**
 * Runs a parse whose timeout timers are driven by a fake clock, so the
 * expiry lands while the load is still waiting on I/O. A real 1 ms timeout is
 * a race here: a warm pdf.js can finish a small load before the timer is due.
 */
async function runWithExpiredTimeout(bytes: Uint8Array): Promise<Outcome> {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const parsing = runParse(bytes, { pageTimeoutMs: 60_000 }).finally(() => {
      settled = true;
    });
    while (!settled) {
      await nextTick();
      mock.timers.tick(60_000);
    }
    return await parsing;
  } finally {
    mock.timers.reset();
  }
}

test("times out an async stall with ParseTimeoutError", async () => {
  const outcome = await runWithExpiredTimeout(await samplePdf());
  assert.equal(outcome.error?.type, ParseTimeoutError.name);
  assert.match(outcome.error?.message ?? "", /PDF extraction exceeded 60000 ms/);
});

// No threads and cleanup --------------------------------------------------------

test("never constructs a Worker", async () => {
  // Replacing the CJS export and syncing the builtin ESM bindings makes any
  // `import { Worker } from "node:worker_threads"` in the parser construct our spy.
  const threads = createRequire(import.meta.url)("node:worker_threads") as {
    Worker: typeof Worker;
  };
  const Original = threads.Worker;
  let constructed = 0;
  threads.Worker = class extends Original {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      constructed++;
      super(...args);
    }
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await runParse(await samplePdf(), {})).error, undefined);
    assert.equal(constructed, 0, "the PDF parser must not spawn a Worker");
  } finally {
    threads.Worker = Original;
    syncBuiltinESMExports();
  }
});

interface PdfjsTask {
  destroy(): Promise<void>;
  readonly promise: Promise<unknown>;
}

/**
 * Records every pdf.js loading task whose `promise` is read (the session reads
 * it right after getDocument) and every task that is destroyed.
 */
async function trackLoadingTasks(): Promise<{
  readonly created: Set<unknown>;
  readonly destroyed: Set<unknown>;
  restore(): void;
}> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(options: { data: Uint8Array }): PdfjsTask;
  };
  const probe = pdfjs.getDocument({ data: await samplePdf() });
  probe.promise.catch(() => undefined);
  const prototype = Object.getPrototypeOf(probe) as PdfjsTask;
  await probe.destroy();

  const created = new Set<unknown>();
  const destroyed = new Set<unknown>();
  const destroy = prototype.destroy;
  const promise = Object.getOwnPropertyDescriptor(prototype, "promise")!;
  prototype.destroy = function (this: PdfjsTask) {
    destroyed.add(this);
    return destroy.call(this);
  };
  Object.defineProperty(prototype, "promise", {
    ...promise,
    get(this: PdfjsTask) {
      created.add(this);
      return (promise.get as () => Promise<unknown>).call(this);
    },
  });
  return {
    created,
    destroyed,
    restore() {
      prototype.destroy = destroy;
      Object.defineProperty(prototype, "promise", promise);
    },
  };
}

const releaseScenarios: ReadonlyArray<{
  readonly name: string;
  readonly bytes: () => Promise<Uint8Array> | Uint8Array;
  readonly options?: PdfParserOptions;
  readonly signal?: () => AbortSignal;
  readonly expire?: true;
  readonly minTasks: number;
  readonly outcome: ErrorClass | null;
}> = [
  { name: "success", bytes: samplePdf, minTasks: 1, outcome: null },
  { name: "recovered load", bytes: lostXrefStream, minTasks: 2, outcome: null },
  { name: "malformed input", bytes: () => text("not a pdf at all"), minTasks: 1, outcome: MalformedDocumentError },
  { name: "encrypted input", bytes: () => encryptedPdf("user-pw"), minTasks: 1, outcome: EncryptedDocumentError },
  { name: "page text limit", bytes: samplePdf, options: { maxPageTextChars: 3 }, minTasks: 1, outcome: LimitExceededError },
  { name: "timeout", bytes: samplePdf, expire: true, minTasks: 0, outcome: ParseTimeoutError },
  { name: "pre-aborted signal", bytes: samplePdf, signal: () => AbortSignal.abort(), minTasks: 0, outcome: AbortError },
  {
    name: "abort while loading",
    bytes: samplePdf,
    signal: () => {
      const controller = new AbortController();
      setImmediate(() => controller.abort());
      return controller.signal;
    },
    minTasks: 0,
    outcome: AbortError,
  },
];

test("destroys every pdf.js loading task on every path", async () => {
  const tracker = await trackLoadingTasks();
  try {
    for (const scenario of releaseScenarios) {
      tracker.created.clear();
      tracker.destroyed.clear();
      const bytes = await scenario.bytes();
      const signal = scenario.signal?.();
      const outcome =
        scenario.expire === true
          ? await runWithExpiredTimeout(bytes)
          : await runParse(
              bytes,
              scenario.options ?? {},
              new ParseContext(signal === undefined ? {} : { signal }),
            );
      // A timed out load may still be starting up; give it time to settle.
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(outcome.error?.type, scenario.outcome?.name, scenario.name);
      assert.ok(
        tracker.created.size >= scenario.minTasks,
        `${scenario.name}: expected at least ${scenario.minTasks} loading tasks, saw ${tracker.created.size}`,
      );
      const leaked = [...tracker.created].filter((task) => !tracker.destroyed.has(task));
      assert.equal(leaked.length, 0, `${scenario.name}: ${leaked.length} loading task(s) not destroyed`);
    }
  } finally {
    tracker.restore();
  }
});

test("leaves no timers or handles behind", async () => {
  const bytes = await samplePdf();
  // Warm up lazily created resources (module loads, thread pool) first.
  await runParse(bytes, {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  await nextTick();
  const before = process.getActiveResourcesInfo().sort();

  assert.equal((await runParse(bytes, {})).error, undefined);
  assert.equal((await runParse(text("not a pdf at all"), {})).error?.type, "MalformedDocumentError");
  assert.equal((await runWithExpiredTimeout(bytes)).error?.type, "ParseTimeoutError");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await nextTick();

  assert.deepEqual(process.getActiveResourcesInfo().sort(), before);
});
