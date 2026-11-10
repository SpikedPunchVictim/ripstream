import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, ParseContext, assertValidLimits, type ParseLimits } from "../src/parse-context.ts";
import { Ripstream } from "../src/ripstream.ts";
import type { Detector } from "../src/parser.ts";
import { MediaType } from "../src/media-type.ts";

/*
 * Every limit is a number a parser compares against (`count > limit`) or hands to a timer. NaN, a string or a negative
 * makes the comparison false forever, and a delay past 2^31-1 fires at once, so each of those would silently turn a
 * limit off or into an instant failure. Measured against the config audit (tasks/parity/audits/config-inventory.json,
 * P01-P11): all of them were accepted. A limit that is wrong is refused, by name, before anything is read.
 */

const COUNT_LIMITS = [
  "maxEmbeddedResources",
  "maxEmbeddedResourceBytes",
  "maxTotalEmbeddedBytes",
  "maxNodeDepth",
  "maxMetadataValueChars",
  "maxZipEntries",
  "maxXmlEntityExpansions",
] as const;
const NOT_COUNTS: readonly unknown[] = [Number.NaN, -1, 0.5, Infinity, -Infinity, "5", null, true, {}, [], 2 ** 53];

for (const name of COUNT_LIMITS) {
  test(`${name} is a non-negative integer`, () => {
    for (const value of NOT_COUNTS) {
      assert.throws(
        () => assertValidLimits({ [name]: value } as Partial<ParseLimits>),
        (error: unknown) => error instanceof RangeError && error.message.includes(name),
        `${name}: ${String(value)}`,
      );
    }
    for (const value of [0, 1, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      assertValidLimits({ [name]: value } as Partial<ParseLimits>);
    }
  });
}

test("output limits keep -1 as unlimited and reject the rest of the negatives", () => {
  for (const name of ["maxOutputChars", "maxDocumentOutputChars"] as const) {
    assertValidLimits({ [name]: -1 });
    assertValidLimits({ [name]: 0 });
    for (const value of [Number.NaN, -2, "5", null, true]) {
      assert.throws(() => assertValidLimits({ [name]: value } as never), new RegExp(name), `${name}: ${String(value)}`);
    }
  }
});

test("maxDecompressionRatio is a positive finite number", () => {
  for (const value of [0, -1, Number.NaN, Infinity, "100", null]) {
    assert.throws(() => assertValidLimits({ maxDecompressionRatio: value } as never), /maxDecompressionRatio/, String(value));
  }
  assertValidLimits({ maxDecompressionRatio: 0.5 });
  assertValidLimits({ maxDecompressionRatio: 1e9 });
});

test("timers are whole milliseconds a timer can hold; maxParseMillis 0 means no parse timer", () => {
  for (const name of ["maxParseMillis", "maxTaskMillis"] as const) {
    // Past 2^31-1 setTimeout fires after 1 ms, so a generous limit would abort every parse at once.
    for (const value of [Number.NaN, -1, 0.5, Infinity, 2 ** 31, "1000", null]) {
      assert.throws(() => assertValidLimits({ [name]: value } as never), new RegExp(name), `${name}: ${String(value)}`);
    }
    assertValidLimits({ [name]: 1 });
    assertValidLimits({ [name]: 2 ** 31 - 1 });
  }
  assertValidLimits({ maxParseMillis: 0 });
  assert.throws(() => assertValidLimits({ maxTaskMillis: 0 }), /maxTaskMillis/);
});

test("an unknown limit is refused by name", () => {
  assert.throws(
    () => assertValidLimits({ maxPages: 3 } as never),
    (error: unknown) => error instanceof RangeError && /unknown limit "maxPages"/.test(error.message),
  );
});

test("every problem is reported at once", () => {
  assert.throws(
    () => assertValidLimits({ maxNodeDepth: -1, bogus: 1, maxParseMillis: Number.NaN } as never),
    (error: unknown) =>
      error instanceof RangeError && /maxNodeDepth/.test(error.message) && /bogus/.test(error.message) && /maxParseMillis/.test(error.message),
  );
});

test("limits that are not an object are refused", () => {
  for (const value of ["maxOutputChars", 5, null, true]) {
    assert.throws(() => assertValidLimits(value as never), RangeError, String(value));
  }
});

test("a limit set to undefined is absent, never an override", () => {
  const context = new ParseContext({ limits: { maxNodeDepth: undefined, maxOutputChars: 7 } as never });
  assert.equal(context.limits.maxNodeDepth, DEFAULT_LIMITS.maxNodeDepth);
  assert.equal(context.limits.maxOutputChars, 7);
  assert.equal(new ParseContext().createChild({ limits: { maxNodeDepth: undefined } as never }).limits.maxNodeDepth, DEFAULT_LIMITS.maxNodeDepth);
});

test("ParseContext and createChild refuse bad limits", () => {
  assert.throws(() => new ParseContext({ limits: { maxNodeDepth: Number.NaN } }), /maxNodeDepth/);
  assert.throws(() => new ParseContext({ limits: { maxPages: 1 } as never }), /unknown limit "maxPages"/);
  assert.throws(() => new ParseContext().createChild({ limits: { maxZipEntries: -1 } }), /maxZipEntries/);
});

const detector: Detector = {
  detect: () => Promise.resolve({ type: MediaType.parse("text/plain") as MediaType, confidence: 1 }),
} as never;

test("Ripstream refuses bad limits before it reads the source or arms a timer", async () => {
  const ripstream = new Ripstream({
    detector,
    parser: { getSupportedTypes: () => new Set(), parse: () => Promise.reject(new Error("must not run")) } as never,
  });
  const bytes = new Uint8Array(1);
  for (const limits of [{ maxParseMillis: 2 ** 31 }, { maxNodeDepth: Number.NaN }, { maxPages: 1 }] as Partial<ParseLimits>[]) {
    await assert.rejects(ripstream.parse(bytes, { limits }), RangeError);
    assert.throws(() => ripstream.parseToStream(bytes, { limits }), RangeError);
  }
});
