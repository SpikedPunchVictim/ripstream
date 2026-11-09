import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, LimitExceededError, type IsolationConfig } from "@spikedpunch/ripstream-core";
import {
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_PER_CHILD_MB,
  MAX_RECORDS_METADATA_BYTES,
  MAX_RESULT_BYTES_CEILING,
  RESULT_SLACK_BYTES,
  TEXT_METADATA_BYTES,
  deriveLimits,
} from "../src/limits.ts";

const MIB = 1024 * 1024;
const strict: IsolationConfig = { mode: "strict" };

test("defaults: a text request with no overrides", () => {
  assert.deepEqual(deriveLimits(strict), {
    perChildMb: 1536,
    rssLimitMb: 1536,
    heapMb: 385, // 384 + ceil(100,000 chars * 8 bytes / MiB) = 384 + 1
    cpuSecs: 65, // ceil(60,000 / 1000) + 5
    maxTaskMillis: 60_000,
    maxParseMillis: 58_000, // 60 s minus the 2 s margin
    maxInputBytes: 100 * MIB,
    maxOutputChars: 100_000,
    maxEmbeddedResources: 10_000,
    output: "text",
    maxResultBytes: 600_000 + 8 * MIB + 64 * 1024, // 100,000 * 6 + metadata allowance + slack
    maxFrameBytes: 8 * MIB, // the meta frame: all metadata travels in one frame
  });
});

test("defaults come from core and the exported constants, not from copies", () => {
  const limits = deriveLimits(strict);
  assert.equal(limits.maxOutputChars, DEFAULT_LIMITS.maxOutputChars);
  assert.equal(limits.maxTaskMillis, DEFAULT_LIMITS.maxTaskMillis);
  assert.equal(limits.maxEmbeddedResources, DEFAULT_LIMITS.maxEmbeddedResources);
  assert.equal(limits.perChildMb, DEFAULT_PER_CHILD_MB);
  assert.equal(limits.maxInputBytes, DEFAULT_MAX_INPUT_BYTES);
});

test("the config's own values win over the defaults", () => {
  const limits = deriveLimits({
    mode: "strict",
    perChildMb: 2048,
    heapMb: 900,
    maxTaskMillis: 20_000,
    maxInputBytes: 5 * MIB,
  });
  assert.deepEqual(
    [limits.perChildMb, limits.rssLimitMb, limits.heapMb, limits.maxTaskMillis, limits.maxInputBytes],
    [2048, 2048, 900, 20_000, 5 * MIB],
  );
});

test("heap derivation: 384 MiB floor, grows with the output cap, 512 MiB ceiling", () => {
  const heap = (maxOutputChars: number): number => deriveLimits(strict, { maxOutputChars }).heapMb;
  assert.equal(heap(0), 384);
  assert.equal(heap(100_000), 385);
  assert.equal(heap(8_388_608), 448); // 64 MiB of text at 8 bytes per character
  assert.equal(heap(10_000_000), 461); // 384 + ceil(76.3)
  assert.equal(heap(16_777_216), 512);
  assert.equal(heap(50_000_000), 512); // clamped
});

test("heap derivation: a small child budget gets half as heap, the config's heapMb is used as given", () => {
  assert.equal(deriveLimits({ mode: "strict", perChildMb: 512 }).heapMb, 256);
  assert.equal(deriveLimits({ mode: "strict", perChildMb: 2 }).heapMb, 1);
  assert.equal(deriveLimits({ mode: "strict", perChildMb: 512, heapMb: 300 }).heapMb, 300);
  assert.equal(deriveLimits({ mode: "strict", heapMb: 1 }).heapMb, 1);
});

test("invariant heapMb < rssLimit (= perChildMb): violations name the numbers", () => {
  assert.throws(
    () => deriveLimits({ mode: "strict", heapMb: 1536 }),
    (error: unknown) =>
      error instanceof RangeError && /heapMb \(1536\)/.test(error.message) && /perChildMb \(1536\)/.test(error.message),
  );
  assert.throws(() => deriveLimits({ mode: "strict", perChildMb: 1024, heapMb: 1024 }), RangeError);
  assert.throws(() => deriveLimits({ mode: "strict", perChildMb: 1024, heapMb: 2000 }), RangeError);
  // A child budget of 1 MiB leaves no whole MiB for a derived heap.
  assert.throws(
    () => deriveLimits({ mode: "strict", perChildMb: 1 }),
    (error: unknown) => error instanceof RangeError && /heapMb \(0, derived\)/.test(error.message),
  );
});

test("cpuSecs: wall budget in seconds, rounded up, plus 5, never above the wrapper's maximum", () => {
  const cpu = (maxTaskMillis: number): number => deriveLimits({ mode: "strict", maxTaskMillis }).cpuSecs;
  assert.equal(cpu(1), 6);
  assert.equal(cpu(1000), 6);
  assert.equal(cpu(1001), 7);
  assert.equal(cpu(59_001), 65);
  assert.equal(cpu(60_000), 65);
  assert.equal(cpu(300_000), 305);
  assert.equal(cpu(2_147_483_647), 86_400);
});

test("maxParseMillis: below the parent's deadline by 2 s or a tenth of it, whichever is less, at least 1", () => {
  const parse = (maxTaskMillis: number): number => deriveLimits({ mode: "strict", maxTaskMillis }).maxParseMillis;
  assert.deepEqual(
    [60_000, 20_000, 15_000, 10_000, 5000, 1000, 100, 10, 2, 1].map(parse),
    [58_000, 18_000, 13_500, 9000, 4500, 900, 90, 9, 1, 1],
  );
  for (const maxTaskMillis of [3, 7, 50, 999, 12_345, 600_000]) {
    assert.ok(parse(maxTaskMillis) < maxTaskMillis, `${maxTaskMillis}`);
    assert.ok(parse(maxTaskMillis) >= 1);
  }
});

test("maxResultBytes: 6 bytes per output character plus the metadata allowance plus slack", () => {
  const text = (maxOutputChars: number): number => deriveLimits(strict, { maxOutputChars }).maxResultBytes;
  assert.equal(text(0), TEXT_METADATA_BYTES + RESULT_SLACK_BYTES);
  assert.equal(text(1), 6 + TEXT_METADATA_BYTES + RESULT_SLACK_BYTES);
  assert.equal(text(1_000_000), 6_000_000 + TEXT_METADATA_BYTES + RESULT_SLACK_BYTES);
  assert.ok(text(2) > text(1));
});

test("text: the frame cap is the metadata allowance (8 MiB), whatever the result cap", () => {
  assert.equal(TEXT_METADATA_BYTES, 8 * MIB);
  assert.equal(deriveLimits(strict, { output: "text", maxOutputChars: 50_000_000 }).maxFrameBytes, TEXT_METADATA_BYTES);
  assert.equal(deriveLimits(strict, { output: "text", maxOutputChars: 10 }).maxFrameBytes, TEXT_METADATA_BYTES);
});

test("records: a record is one frame, so the frame cap equals the result cap", () => {
  for (const maxOutputChars of [0, 100_000, 5_000_000]) {
    const limits = deriveLimits(strict, { output: "records", maxOutputChars });
    assert.equal(limits.maxFrameBytes, limits.maxResultBytes, `${maxOutputChars}`);
    assert.equal(limits.output, "records");
  }
});

test("records: the metadata allowance is 4 KiB per record, between the 8 MiB text allowance and 16 MiB", () => {
  const bytes = (maxEmbeddedResources: number): number =>
    deriveLimits(strict, { output: "records", maxOutputChars: 0, maxEmbeddedResources }).maxResultBytes - RESULT_SLACK_BYTES;
  assert.equal(bytes(0), TEXT_METADATA_BYTES); // 1 record = 4 KiB, raised to the text allowance
  assert.equal(bytes(100), TEXT_METADATA_BYTES);
  assert.equal(bytes(1000), TEXT_METADATA_BYTES); // 1001 * 4096 is about 4 MiB, still under the floor
  assert.equal(bytes(3000), 3001 * 4096);
  assert.equal(bytes(10_000), MAX_RECORDS_METADATA_BYTES); // the default would be 40 MB, capped
  assert.equal(MAX_RECORDS_METADATA_BYTES, 16 * MIB);
});

test("records with the default embedded-resource cap", () => {
  const limits = deriveLimits(strict, { output: "records" });
  assert.equal(limits.maxResultBytes, 600_000 + 16 * MIB + RESULT_SLACK_BYTES);
  assert.equal(limits.maxEmbeddedResources, 10_000);
});

test("an explicit request value is the effective one", () => {
  const limits = deriveLimits(strict, { maxOutputChars: 42, maxEmbeddedResources: 7, output: "records" });
  assert.equal(limits.maxOutputChars, 42);
  assert.equal(limits.maxEmbeddedResources, 7);
});

test("maxOutputChars -1 (unlimited) cannot be isolated", () => {
  assert.throws(
    () => deriveLimits(strict, { maxOutputChars: -1 }),
    (error: unknown) => error instanceof RangeError && /-1/.test(error.message) && /finite/.test(error.message),
  );
});

test("maxOutputChars and maxEmbeddedResources must be non-negative safe integers", () => {
  for (const maxOutputChars of [-2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
    assert.throws(() => deriveLimits(strict, { maxOutputChars }), RangeError, `${maxOutputChars}`);
  }
  for (const maxEmbeddedResources of [-1, 0.5, Number.NaN, Infinity]) {
    assert.throws(() => deriveLimits(strict, { maxEmbeddedResources }), RangeError, `${maxEmbeddedResources}`);
  }
});

test("a huge maxOutputChars is a LimitExceededError at the ceiling, not an unbounded result", () => {
  // The largest cap whose result still fits (the division is not exact, so the result sits 0-5 bytes below).
  const atCeiling = Math.floor((MAX_RESULT_BYTES_CEILING - TEXT_METADATA_BYTES - RESULT_SLACK_BYTES) / 6);
  const atLimit = deriveLimits(strict, { maxOutputChars: atCeiling }).maxResultBytes;
  assert.ok(atLimit <= MAX_RESULT_BYTES_CEILING && atLimit > MAX_RESULT_BYTES_CEILING - 6, `${atLimit}`);
  assert.throws(() => deriveLimits(strict, { maxOutputChars: atCeiling + 1 }), LimitExceededError);
  assert.throws(() => deriveLimits(strict, { maxOutputChars: 1e12 }), LimitExceededError);
  // The same cap applies to records, whose allowance is larger.
  assert.throws(() => deriveLimits(strict, { output: "records", maxOutputChars: atCeiling }), LimitExceededError);
});

test("the result is plain data and the config is not touched", () => {
  const config: IsolationConfig = Object.freeze({ mode: "strict", perChildMb: 1024 });
  const limits = deriveLimits(config, { output: "records" });
  assert.deepEqual(JSON.parse(JSON.stringify(limits)), limits);
  assert.deepEqual(config, { mode: "strict", perChildMb: 1024 });
});
