import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTick } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { mock, test } from "node:test";
import {
  AbortError,
  BodyContentHandler,
  EmbeddedDocumentBytesHandler,
  EmptyPasswordProvider,
  CONTEXT_KEYS,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  ParseTimeoutError,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { PdfParser } from "../src/index.ts";
import type { PdfParserOptions } from "../src/pdf.ts";
import {
  encryptedPdf,
  helloPdf,
  manyPagesPdf,
  rawPdf,
  samplePdf,
} from "./fixtures.ts";

const MODES = [
  { name: "worker", inline: false },
  { name: "inline", inline: true },
] as const;

interface Outcome {
  readonly text: string;
  readonly metadata: ReadonlyArray<readonly [string, string]>;
  readonly error?: { readonly type: string; readonly message: string; readonly cause?: string };
}

async function runParse(
  bytes: Uint8Array,
  options: PdfParserOptions,
  context = new ParseContext(),
  handler = new BodyContentHandler(),
): Promise<Outcome> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  const entries = (): Array<readonly [string, string]> =>
    [...metadata].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  try {
    await new PdfParser(options).parse(stream, handler, metadata, context);
    return { text: handler.toString(), metadata: entries() };
  } catch (error) {
    assert.ok(error instanceof Error, "parse must reject with an Error");
    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    return {
      text: handler.toString(),
      metadata: entries(),
      error: {
        type: error.constructor.name,
        message: error.message,
        ...(cause === undefined ? {} : { cause }),
      },
    };
  } finally {
    await stream.close();
  }
}

type ErrorClass = new (...args: never[]) => Error;

interface Scenario {
  readonly name: string;
  readonly bytes: () => Promise<Uint8Array> | Uint8Array;
  readonly options?: PdfParserOptions;
  readonly context?: () => ParseContext;
  /** Text the parse must produce, or the error class it must fail with. */
  readonly expect: RegExp | ErrorClass;
}

async function annotatedPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Annotated", { x: 72, y: 700, size: 12, font });
  const link = document.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [72, 600, 220, 620],
    A: { S: "URI", URI: PDFString.of("https://example.com/docs") },
  });
  const note = document.context.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [72, 560, 92, 580],
    T: PDFString.of("Ada"),
    Subj: PDFString.of("Review"),
    Contents: PDFString.of("Please check this section"),
  });
  const references = [link, note].map((annotation) => document.context.register(annotation));
  page.node.set(PDFName.of("Annots"), document.context.obj(references));
  return document.save();
}

async function formPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const field = document.getForm().createTextField("customer");
  field.setText("Ada Lovelace");
  field.addToPage(page, { x: 72, y: 600, width: 200, height: 20 });
  return document.save();
}

async function attachmentPdf(content: Uint8Array): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage();
  await document.attach(content, "note.txt", { mimeType: "text/plain" });
  return document.save();
}

async function twoPagePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage();
  first.drawText("Bottom line", { x: 72, y: 600, size: 12, font });
  first.drawText("Top line", { x: 72, y: 700, size: 12, font });
  document.addPage().drawText("Page two", { x: 72, y: 700, size: 12, font });
  return document.save();
}

const brokenXref = (): Uint8Array => {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 72 700 Td (Recovered) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    objects.map(() => "0000000000 00000 n \n").join("");
  return new TextEncoder().encode(
    `%PDF-1.4\n${objects.join("")}${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`,
  );
};

async function withoutXref(): Promise<Uint8Array> {
  const bytes = await helloPdf(false);
  return bytes.subarray(0, bytes.indexOf("xref\n"));
}

/** The catalog lives in an object stream and the xref stream was cut off. */
async function lostXrefStream(): Promise<Uint8Array> {
  const bytes = await helloPdf(true);
  const xrefObject = bytes.lastIndexOf("/Type /XRef");
  return bytes.subarray(0, bytes.lastIndexOf("obj", xrefObject) - 8);
}

const text = (source: string): Uint8Array => new TextEncoder().encode(source);

const scenarios: readonly Scenario[] = [
  { name: "plain text and metadata", bytes: samplePdf, expect: /Hello PDF/ },
  { name: "empty password provider", bytes: samplePdf, options: { password: new EmptyPasswordProvider() }, expect: /Hello PDF/ },
  { name: "annotations and links", bytes: annotatedPdf, expect: /Please check this section/ },
  { name: "AcroForm fields", bytes: formPdf, expect: /Ada Lovelace/ },
  { name: "attachment listing", bytes: () => attachmentPdf(text("attached text")), expect: /note\.txt/ },
  { name: "page order and separator", bytes: twoPagePdf, options: { pageSeparator: "---PAGE---" }, expect: /---PAGE---[\s\S]*Page two/ },
  { name: "broken xref table", bytes: brokenXref, expect: /Recovered/ },
  { name: "missing xref and trailer", bytes: withoutXref, expect: /Recovered text/ },
  { name: "catalog in an object stream, xref stream lost", bytes: lostXrefStream, expect: /Recovered text/ },
  { name: "not a PDF", bytes: () => text("not a pdf at all"), expect: MalformedDocumentError },
  { name: "no catalog anywhere", bytes: () => text("%PDF-1.4\n1 0 obj\n<< /Pages 2 0 R >>\nendobj\n"), expect: MalformedDocumentError },
  {
    name: "object number beyond the PDF limit",
    bytes: () =>
      text(
        "%PDF-1.7\n1 0 obj <</Type /Catalog /Pages 2 0 R>>\nendobj\n" +
          "2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n" +
          "3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 10 10]>>\nendobj\n" +
          "2147483647 0 obj <</Root 1 0 R>>\nendobj\n",
      ),
    expect: MalformedDocumentError,
  },
  {
    name: "font program length beyond the cap",
    bytes: () =>
      rawPdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] >>",
        "<< /Length 4 /Length1 274877906944 >>\nstream\nabcd\nendstream",
      ]),
    expect: MalformedDocumentError,
  },
  { name: "encrypted, no password", bytes: () => encryptedPdf("user-pw"), expect: EncryptedDocumentError },
  { name: "encrypted, wrong password", bytes: () => encryptedPdf("user-pw"), options: { password: "wrong" }, expect: EncryptedDocumentError },
  { name: "encrypted, right password", bytes: () => encryptedPdf("user-pw"), options: { password: "user-pw" }, expect: /Secret text/ },
  {
    name: "encrypted, password provider",
    bytes: () => encryptedPdf("user-pw"),
    options: { password: { getPassword: () => "user-pw" } },
    expect: /Secret text/,
  },
  { name: "page text limit", bytes: samplePdf, options: { maxPageTextChars: 3 }, expect: LimitExceededError },
  { name: "input size limit", bytes: samplePdf, options: { maxInputBytes: 100 }, expect: LimitExceededError },
  {
    name: "attachment count limit",
    bytes: () => attachmentPdf(text("one")),
    context: () => new ParseContext({ limits: { maxEmbeddedResources: 0 } }),
    expect: LimitExceededError,
  },
  {
    name: "attachment size limit",
    bytes: () => attachmentPdf(new Uint8Array(1000)),
    context: () => new ParseContext({ limits: { maxEmbeddedResourceBytes: 100 } }),
    expect: LimitExceededError,
  },
];

for (const scenario of scenarios) {
  test(`worker and inline modes agree: ${scenario.name}`, async () => {
    const bytes = await scenario.bytes();
    const outcomes = new Map<string, Outcome>();
    for (const mode of MODES) {
      outcomes.set(
        mode.name,
        await runParse(
          bytes,
          { ...scenario.options, inline: mode.inline },
          scenario.context?.() ?? new ParseContext(),
        ),
      );
    }

    for (const [mode, outcome] of outcomes) {
      if (typeof scenario.expect === "function") {
        assert.equal(outcome.error?.type, scenario.expect.name, `${mode} error class`);
      } else {
        assert.equal(outcome.error, undefined, `${mode} must not fail`);
        assert.match(outcome.text, scenario.expect, `${mode} text`);
      }
    }
    assert.deepEqual(outcomes.get("inline"), outcomes.get("worker"));
  });
}

test("inline mode reports the same PDF metadata as worker mode", async () => {
  const outcome = await runParse(await samplePdf(), { inline: true });
  const metadata = new Map(outcome.metadata);
  assert.equal(metadata.get("dc:title"), "Sample");
  assert.equal(metadata.get("dc:creator"), "Ada");
  assert.equal(metadata.get("pdf:PageCount"), "1");
  assert.match(metadata.get("dcterms:created") ?? "", /^2024-01-01/);
});

test("inline mode hands attachment bytes to the embedded document extractor", async () => {
  const bytes = await attachmentPdf(text("attached text"));
  const resources = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const outcome = await runParse(bytes, { inline: true }, context);
  assert.equal(outcome.error, undefined);
  assert.equal(resources.resources.length, 1);
  assert.equal(new TextDecoder().decode(resources.resources[0]?.bytes), "attached text");
});

test("inline mode ignores workerMemoryMb", async () => {
  const outcome = await runParse(await samplePdf(), { inline: true, workerMemoryMb: 1 });
  assert.equal(outcome.error, undefined);
  assert.match(outcome.text, /Hello PDF/);
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

for (const mode of MODES) {
  test(`${mode.name} mode honours an already aborted signal`, async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runParse(
      new Uint8Array([1, 2, 3]),
      { inline: mode.inline },
      new ParseContext({ signal: controller.signal }),
    );
    assert.equal(outcome.error?.type, AbortError.name);
  });

  test(`${mode.name} mode stops when aborted from the content handler`, async () => {
    const controller = new AbortController();
    const outcome = await runParse(
      await manyPagesPdf(5),
      { inline: mode.inline },
      new ParseContext({ signal: controller.signal }),
      new AbortingHandler(() => controller.abort()),
    );
    assert.equal(outcome.error?.type, AbortError.name);
  });

  test(`${mode.name} mode stops when aborted between pages`, async () => {
    const controller = new AbortController();
    const outcome = await runParse(
      await manyPagesPdf(5),
      { inline: mode.inline },
      new ParseContext({ signal: controller.signal }),
      new AbortingHandler(() => {
        setImmediate(() => controller.abort());
      }),
    );
    assert.equal(outcome.error?.type, AbortError.name);
  });
}

/**
 * Runs an inline parse whose timeout timers are driven by a fake clock, so the
 * expiry lands while the load is still waiting on I/O. A real 1 ms timeout is
 * a race here: a warm pdf.js can finish a small load before the timer is due.
 */
async function runWithExpiredTimeout(bytes: Uint8Array): Promise<Outcome> {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const parsing = runParse(bytes, { inline: true, pageTimeoutMs: 60_000 }).finally(() => {
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

test("inline mode times out an async stall with ParseTimeoutError", async () => {
  const outcome = await runWithExpiredTimeout(await samplePdf());
  assert.equal(outcome.error?.type, ParseTimeoutError.name);
  assert.match(outcome.error?.message ?? "", /PDF extraction exceeded 60000 ms/);
});

// Isolation from threads and cleanup -------------------------------------------

test("inline mode never constructs a Worker, worker mode does", async () => {
  // pdf.ts imports Worker from node:worker_threads; replacing the CJS export
  // and syncing the builtin ESM bindings makes that import construct our spy.
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
    const bytes = await samplePdf();
    assert.equal((await runParse(bytes, { inline: true })).error, undefined);
    assert.equal(constructed, 0, "inline mode must not spawn a Worker");

    assert.equal((await runParse(bytes, { inline: false })).error, undefined);
    assert.equal(constructed, 1, "the spy must see worker mode spawn its Worker");
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

test("inline mode destroys every pdf.js loading task on every path", async () => {
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
              { ...scenario.options, inline: true },
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

test("inline mode leaves no timers or handles behind", async () => {
  const bytes = await samplePdf();
  // Warm up lazily created resources (module loads, thread pool) first.
  await runParse(bytes, { inline: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await nextTick();
  const before = process.getActiveResourcesInfo().sort();

  assert.equal((await runParse(bytes, { inline: true })).error, undefined);
  assert.equal((await runParse(text("not a pdf at all"), { inline: true })).error?.type, "MalformedDocumentError");
  assert.equal((await runWithExpiredTimeout(bytes)).error?.type, "ParseTimeoutError");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await nextTick();

  assert.deepEqual(process.getActiveResourcesInfo().sort(), before);
});
