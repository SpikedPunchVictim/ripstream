import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttributesImpl,
  LowYieldError,
  MAX_WARNINGS,
  MAX_WARNINGS_PER_RESULT,
  MediaType,
  Metadata,
  Ripstream,
  TIKA_KEYS,
  WarningSink,
  addParseWarning,
  assertLowYieldPolicy,
  enforceLowYield,
  httpStatusForError,
  isLowYield,
  parseWireWarnings,
  recordWarnings,
  tallyPart,
  type ContentHandler,
  type Detector,
  type ParseContext,
  type ParseWarning,
  type Parser,
} from "../src/index.ts";

/** The typed warnings of a result (tikajs-icjf): what is low yield, how they are collected, what the wire accepts. */

const scan = (chars: number, of = 1): ParseWarning => ({ kind: "image-only", pages: of, of, pageNumbers: [1], chars });

test("partial is always low yield, truncated never", () => {
  assert.equal(isLowYield({ kind: "partial", reason: "entries-failed", failed: 1, of: 100 }), true);
  assert.equal(isLowYield({ kind: "truncated", limit: "outputChars" }), false);
});

test("image-only and repaired are low yield below 20 characters a page, and not at 20", () => {
  assert.equal(isLowYield(scan(19)), true);
  assert.equal(isLowYield(scan(20)), false);
  assert.equal(isLowYield(scan(99, 5)), true);
  assert.equal(isLowYield(scan(100, 5)), false);
  assert.equal(isLowYield({ kind: "repaired", steps: ["rebuilt-xref"], of: 2, chars: 39 }), true);
  assert.equal(isLowYield({ kind: "repaired", steps: ["rebuilt-xref"], of: 2, chars: 40 }), false);
  assert.equal(isLowYield({ kind: "repaired", steps: [], of: 0, chars: 19 }), true, "no pages counts as one");
});

test("a failure tally is a partial warning, and a tally with nothing failed is none", () => {
  const sink = new WarningSink();
  sink.tally("pages-failed", true);
  sink.tally("pages-failed", false);
  sink.tally("entries-failed", true);
  assert.deepEqual(sink.finish(new Metadata()), [{ kind: "partial", reason: "pages-failed", failed: 1, of: 2 }]);
});

test("a scoped sink names the embedded document's path, and the document's own warnings have none", () => {
  const sink = new WarningSink();
  sink.add({ kind: "truncated", limit: "zipEntries" });
  sink.scoped("/a.zip/b.pdf").add({ kind: "truncated", limit: "outputChars" });
  sink.scoped("/a.zip/b.pdf").tally("embedded-failed", false);
  assert.deepEqual(sink.finish(new Metadata()), [
    { kind: "truncated", limit: "zipEntries" },
    { kind: "truncated", limit: "outputChars", path: "/a.zip/b.pdf" },
    { kind: "partial", reason: "embedded-failed", failed: 1, of: 1, path: "/a.zip/b.pdf" },
  ]);
});

test("truncation flags in the metadata become truncated warnings", () => {
  const metadata = new Metadata();
  metadata.set(TIKA_KEYS.WRITE_LIMIT_REACHED, "true");
  metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_REACHED, "true");
  metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT, "maxZipEntries");
  assert.deepEqual(new WarningSink().finish(metadata), [
    { kind: "truncated", limit: "outputChars" },
    { kind: "truncated", limit: "zipEntries" },
  ]);
});

test("a clean sink has no warnings", () => {
  assert.deepEqual(new WarningSink().finish(new Metadata()), []);
});

test("past the cap the rest are counted in one warnings-capped warning", () => {
  const sink = new WarningSink();
  for (let index = 0; index < MAX_WARNINGS + 7; index++) sink.add({ kind: "truncated", limit: "outputChars" });
  const warnings = sink.finish(new Metadata());
  assert.equal(warnings.length, MAX_WARNINGS + 1);
  assert.deepEqual(warnings.at(-1), { kind: "partial", reason: "warnings-capped", failed: 7, of: MAX_WARNINGS + 7 });
  assert.ok(warnings.length <= MAX_WARNINGS_PER_RESULT);
});

test("addParseWarning and tallyPart do nothing when the parse collects none", () => {
  const ctx = { get: () => undefined } as unknown as ParseContext;
  addParseWarning(ctx, { kind: "truncated", limit: "outputChars" });
  tallyPart(ctx, "pages-failed", false);
});

test("enforceLowYield throws a LowYieldError with the low-yield warnings only, and only under throw", () => {
  const low = scan(0);
  const fine: ParseWarning = { kind: "truncated", limit: "outputChars" };
  enforceLowYield(undefined, [low]);
  enforceLowYield("record", [low]);
  enforceLowYield("throw", []);
  enforceLowYield("throw", [fine]);
  assert.throws(
    () => enforceLowYield("throw", [fine, low]),
    (error: unknown) => error instanceof LowYieldError && error.code === "LOW_YIELD" && error.warnings.length === 1 && error.warnings[0] === low,
  );
});

test("the message names the warning, and a path when it has one", () => {
  const error = new LowYieldError([{ ...scan(0, 5), path: "/a.zip/b.pdf" } as ParseWarning, scan(0)]);
  assert.match(error.message, /5 of 5 pages are images with no text, 0 characters in all in \/a\.zip\/b\.pdf \(and 1 more\)/);
});

test("a LowYieldError is a 422", () => {
  assert.equal(httpStatusForError(new LowYieldError([scan(0)])), 422);
});

test("an onLowYield that is neither record nor throw is refused", () => {
  assertLowYieldPolicy(undefined);
  assertLowYieldPolicy("record");
  assert.throws(() => assertLowYieldPolicy("always"), TypeError);
});

test("recordWarnings names the warnings of an embedded record by its path, and leaves the container's alone", () => {
  const all = recordWarnings([
    { depth: 0, embeddedResourcePath: "/a.zip", warnings: [scan(0)] },
    { depth: 1, embeddedResourcePath: "/a.zip/b.pdf", warnings: [scan(0)] },
    { depth: 1, embeddedResourcePath: "/a.zip/c.pdf" },
  ]);
  assert.equal(all.length, 2);
  assert.equal(all[0]?.path, undefined);
  assert.equal(all[1]?.path, "/a.zip/b.pdf");
});

test("the wire accepts every kind and returns plain copies", () => {
  const sent: ParseWarning[] = [
    scan(3),
    { kind: "repaired", steps: ["rebuilt-xref"], of: 2, chars: 40, path: "/x" },
    { kind: "truncated", limit: "embeddedResources" },
    { kind: "partial", reason: "sheets-failed", failed: 1, of: 2 },
  ];
  const got = parseWireWarnings(JSON.parse(JSON.stringify(sent)));
  assert.deepEqual(got, sent);
});

test("the wire refuses what a child could use to make the parent hold more than it should", () => {
  const refused: unknown[] = [
    "not a list",
    [null],
    [{ kind: "nonsense" }],
    [{ kind: "truncated", limit: "outputChars", extra: 1 }],
    [{ kind: "truncated", limit: "everything" }],
    [{ kind: "partial", reason: "pages-failed", failed: -1, of: 1 }],
    [{ kind: "partial", reason: "pages-failed", failed: 1.5, of: 2 }],
    [{ kind: "partial", reason: "because", failed: 1, of: 2 }],
    [{ kind: "image-only", pages: 1, of: 1, pageNumbers: Array.from({ length: 101 }, (_, i) => i), chars: 0 }],
    [{ kind: "image-only", pages: 1, of: 1, pageNumbers: ["1"], chars: 0 }],
    [{ kind: "repaired", steps: Array.from({ length: 33 }, () => "x"), of: 1, chars: 0 }],
    [{ kind: "repaired", steps: ["x".repeat(101)], of: 1, chars: 0 }],
    [{ kind: "truncated", limit: "outputChars", path: "x".repeat(1025) }],
    Array.from({ length: MAX_WARNINGS_PER_RESULT + 1 }, () => ({ kind: "truncated", limit: "outputChars" })),
  ];
  for (const value of refused) assert.equal(typeof parseWireWarnings(value), "string", JSON.stringify(value).slice(0, 80));
});

// ---- through a Ripstream ---------------------------------------------------------------------------------------------

const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };

function ripstreamWith(raise: (ctx: ParseContext) => void): Ripstream {
  const parser: Parser = {
    name: "Warning",
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, handler: ContentHandler, _metadata, ctx): Promise<void> {
      await handler.startElement?.("", "body", "body", new AttributesImpl([]));
      await handler.characters?.("text", 0, 4);
      await handler.endElement?.("", "body", "body");
      raise(ctx);
    },
  };
  return new Ripstream({ detector, parser });
}

const input = new TextEncoder().encode("x");

test("a clean parse has an empty warnings array, and the policy does not change the text", async () => {
  const result = await ripstreamWith(() => {}).parse(input, { onLowYield: "throw" });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.text.trim(), "text");
});

test("a warning a parser raises is on the result and on every record, and is recorded by default", async () => {
  const ripstream = ripstreamWith((ctx) => addParseWarning(ctx, { kind: "image-only", pages: 1, of: 1, pageNumbers: [1], chars: 0 }));
  const result = await ripstream.parse(input);
  assert.deepEqual(result.warnings, [scan(0)]);
  const records = await ripstream.parseRecursive(input);
  assert.deepEqual(records[0]?.warnings, [scan(0)]);
});

test("onLowYield throw raises the typed error from parse and parseRecursive, and record keeps the result", async () => {
  const ripstream = ripstreamWith((ctx) => addParseWarning(ctx, { kind: "image-only", pages: 1, of: 1, pageNumbers: [1], chars: 0 }));
  await assert.rejects(ripstream.parse(input, { onLowYield: "throw" }), LowYieldError);
  await assert.rejects(ripstream.parseRecursive(input, { onLowYield: "throw" }), LowYieldError);
  assert.equal((await ripstream.parse(input, { onLowYield: "record" })).warnings.length, 1);
  await assert.rejects(ripstream.parse(input, { onLowYield: "sometimes" as "throw" }), TypeError);
});

test("a warning that is not low yield does not throw", async () => {
  const ripstream = ripstreamWith((ctx) => addParseWarning(ctx, { kind: "image-only", pages: 1, of: 1, pageNumbers: [1], chars: 500 }));
  const result = await ripstream.parse(input, { onLowYield: "throw" });
  assert.equal(result.warnings.length, 1);
});

test("a part that failed makes the result partial", async () => {
  const ripstream = ripstreamWith((ctx) => {
    tallyPart(ctx, "entries-failed", true);
    tallyPart(ctx, "entries-failed", false);
  });
  const result = await ripstream.parse(input);
  assert.deepEqual(result.warnings, [{ kind: "partial", reason: "entries-failed", failed: 1, of: 2 }]);
  await assert.rejects(ripstream.parse(input, { onLowYield: "throw" }), LowYieldError);
});
