import assert from "node:assert/strict";
import { test } from "node:test";
import { RipstreamConfig, RipstreamConfigError, loadConfig, validateConfig } from "../src/index.ts";

/*
 * A `parse-context` section is Tika's: it carries `embedded-limits`, `output-limits` and `timeout-limits`
 * (tika-core 4.2.0: EmbeddedLimits, OutputLimits, TimeoutLimits). Ripstream applies the keys that mean the same here:
 *
 *   embedded-limits.maxDepth            -> ParseLimits.maxNodeDepth        (same boundary: a child deeper than N is refused)
 *   embedded-limits.maxCount            -> ParseLimits.maxEmbeddedResources (same boundary: the N+1st embedded document is refused)
 *   output-limits.writeLimit            -> ParseLimits.maxOutputChars
 *   timeout-limits.totalTaskTimeoutMillis -> ParseLimits.maxParseMillis
 *
 * Tika's own default for each of those limits is to stop quietly and set a flag (throwOnMaxDepth, throwOnMaxCount,
 * throwOnWriteLimit and throwOnDeadline are false). Ripstream fails the parse at a limit, which is what Tika does with
 * the flag true, so a limit is accepted only beside its flag set to true. Every other key is refused by name.
 */

const limitsOf = (parseContext: unknown): RipstreamConfig["limits"] => loadConfig({ "parse-context": parseContext }).limits;
const issuesOf = (parseContext: unknown): string[] => validateConfig({ "parse-context": parseContext });

test("no parse-context section, an empty one, and empty blocks set no limits", () => {
  assert.equal(loadConfig({}).limits, null);
  assert.equal(limitsOf({}), null);
  assert.equal(limitsOf({ "embedded-limits": {}, "output-limits": {}, "timeout-limits": {} }), null);
  assert.equal(new RipstreamConfig().limits, null);
});

test("each applied key becomes the ripstream limit that means the same", () => {
  assert.deepEqual(limitsOf({ "embedded-limits": { maxDepth: 5, throwOnMaxDepth: true } }), { maxNodeDepth: 5 });
  assert.deepEqual(limitsOf({ "embedded-limits": { maxCount: 50, throwOnMaxCount: true } }), { maxEmbeddedResources: 50 });
  assert.deepEqual(limitsOf({ "output-limits": { writeLimit: 2000, throwOnWriteLimit: true } }), { maxOutputChars: 2000 });
  assert.deepEqual(limitsOf({ "timeout-limits": { totalTaskTimeoutMillis: 30000, throwOnDeadline: true } }), { maxParseMillis: 30000 });
  assert.deepEqual(
    limitsOf({
      "embedded-limits": { maxDepth: 0, throwOnMaxDepth: true, maxCount: 0, throwOnMaxCount: true },
      "output-limits": { writeLimit: -1 },
    }),
    { maxNodeDepth: 0, maxEmbeddedResources: 0, maxOutputChars: -1 },
  );
});

test("throwOnWriteLimit is read: true only when the section sets it true, so serve fails at the limit instead of truncating", () => {
  const flag = (parseContext: unknown): boolean => loadConfig({ "parse-context": parseContext }).throwOnWriteLimit;
  assert.equal(loadConfig({}).throwOnWriteLimit, false);
  assert.equal(new RipstreamConfig().throwOnWriteLimit, false);
  assert.equal(flag({ "output-limits": { writeLimit: 2000, throwOnWriteLimit: true } }), true);
  assert.equal(flag({ "output-limits": { throwOnWriteLimit: true } }), true);
  assert.equal(flag({ "output-limits": { writeLimit: -1, throwOnWriteLimit: false } }), false);
  assert.equal(flag({ "embedded-limits": { maxCount: 3, throwOnMaxCount: true } }), false, "another block's flag is not this one");
});

test("the loaded limits are a frozen copy", () => {
  const section = { "embedded-limits": { maxCount: 3, throwOnMaxCount: true } };
  const limits = limitsOf(section);
  assert.equal(Object.isFrozen(limits), true);
  section["embedded-limits"].maxCount = 99;
  assert.deepEqual(limits, { maxEmbeddedResources: 3 });
});

test("a limit without its throw flag set to true is refused: Tika would stop quietly, ripstream fails", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ "embedded-limits": { maxDepth: 5 } }, /embedded-limits: maxDepth needs throwOnMaxDepth: true/],
    [{ "embedded-limits": { maxDepth: 5, throwOnMaxDepth: false } }, /embedded-limits: maxDepth needs throwOnMaxDepth: true/],
    [{ "embedded-limits": { maxCount: 5 } }, /embedded-limits: maxCount needs throwOnMaxCount: true/],
    [{ "output-limits": { writeLimit: 100 } }, /output-limits: writeLimit needs throwOnWriteLimit: true/],
    [{ "output-limits": { writeLimit: 100, throwOnWriteLimit: false } }, /output-limits: writeLimit needs throwOnWriteLimit: true/],
    [{ "timeout-limits": { totalTaskTimeoutMillis: 1000 } }, /timeout-limits: totalTaskTimeoutMillis needs throwOnDeadline: true/],
  ];
  for (const [section, pattern] of cases) {
    const issues = issuesOf(section);
    assert.equal(issues.length, 1, JSON.stringify(section));
    assert.match(issues[0]!, pattern, JSON.stringify(section));
    assert.match(issues[0]!, /ripstream fails the parse/, JSON.stringify(section));
    assert.throws(() => loadConfig({ "parse-context": section }), RipstreamConfigError);
  }
});

test("a throw flag with no limit beside it is Tika's default or ripstream's behaviour, so it is accepted", () => {
  for (const section of [
    { "embedded-limits": { throwOnMaxDepth: true, throwOnMaxCount: true } },
    { "embedded-limits": { throwOnMaxDepth: false, throwOnMaxCount: false } },
    { "output-limits": { throwOnWriteLimit: false } },
    { "timeout-limits": { throwOnDeadline: false } },
  ]) {
    assert.deepEqual(issuesOf(section), [], JSON.stringify(section));
    assert.equal(limitsOf(section), null);
  }
});

test("an unlimited writeLimit needs no throw flag; an unlimited depth or count is not available", () => {
  assert.deepEqual(issuesOf({ "output-limits": { writeLimit: -1 } }), []);
  assert.deepEqual(limitsOf({ "output-limits": { writeLimit: -1, throwOnWriteLimit: false } }), { maxOutputChars: -1 });
  for (const section of [
    { "embedded-limits": { maxDepth: -1, throwOnMaxDepth: true } },
    { "embedded-limits": { maxCount: -1, throwOnMaxCount: true } },
  ]) {
    const issues = issuesOf(section);
    assert.equal(issues.length, 1, JSON.stringify(section));
    assert.match(issues[0]!, /ripstream bounds embedded (depth|count): -1 \(unlimited\) is not available/);
  }
});

test("every Tika key ripstream has no counterpart for is refused by name, with the reason", () => {
  const cases: Array<[string, string, unknown, RegExp]> = [
    ["output-limits", "maxXmlDepth", 100, /maxXmlDepth is not supported: ripstream has no limit on XML element nesting/],
    ["output-limits", "maxPackageEntryDepth", 20, /maxPackageEntryDepth is not supported: .*deprecated.*embedded-limits\.maxDepth/],
    ["output-limits", "zipBombThreshold", 1_000_000, /zipBombThreshold is not supported: .*output characters.*input bytes/],
    ["output-limits", "zipBombRatio", 1000, /zipBombRatio is not supported: .*output characters.*input bytes/],
    ["timeout-limits", "progressTimeoutMillis", 60000, /progressTimeoutMillis is not supported: ripstream has no stall detector/],
  ];
  for (const [block, key, value, pattern] of cases) {
    const issues = issuesOf({ [block]: { [key]: value } });
    assert.equal(issues.length, 1, key);
    assert.match(issues[0]!, new RegExp(`parse-context ${block}: `), key);
    assert.match(issues[0]!, pattern, key);
  }
});

test("an unknown setting, an unknown block and a wrong shape are refused", () => {
  assert.match(issuesOf({ "embedded-limits": { maxDepht: 3 } }).join(";"), /embedded-limits: unknown setting "maxDepht"/);
  assert.match(issuesOf({ "embedded-limits": { throwOnWriteLimit: true } }).join(";"), /embedded-limits: unknown setting "throwOnWriteLimit"/);
  assert.match(
    issuesOf({ "digester-factory": {} }).join(";"),
    /parse-context: "digester-factory" is not supported: ripstream reads only embedded-limits, output-limits, timeout-limits and unpack-config/,
  );
  for (const section of ["limits", [], null, 3]) {
    assert.match(issuesOf(section).join(";"), /parse-context must be an object/, JSON.stringify(section));
  }
  for (const block of ["embedded-limits", "output-limits", "timeout-limits"]) {
    for (const value of ["x", [], null, 7]) {
      assert.match(issuesOf({ [block]: value }).join(";"), new RegExp(`${block} must be an object`), `${block} ${JSON.stringify(value)}`);
    }
  }
});

test("a value of the wrong type or out of range is refused, never coerced", () => {
  const bad: Array<[string, string, unknown]> = [
    ["embedded-limits", "maxDepth", "5"],
    ["embedded-limits", "maxDepth", 1.5],
    ["embedded-limits", "maxDepth", -2],
    ["embedded-limits", "maxCount", Number.MAX_SAFE_INTEGER + 1],
    ["embedded-limits", "maxCount", null],
    ["output-limits", "writeLimit", -2],
    ["output-limits", "writeLimit", 2 ** 31],
    ["output-limits", "writeLimit", "100"],
    ["timeout-limits", "totalTaskTimeoutMillis", 0],
    ["timeout-limits", "totalTaskTimeoutMillis", -1],
    ["timeout-limits", "totalTaskTimeoutMillis", 2 ** 31],
    ["timeout-limits", "totalTaskTimeoutMillis", 1.5],
    ["timeout-limits", "totalTaskTimeoutMillis", "1000"],
  ];
  for (const [block, key, value] of bad) {
    const flag = { maxDepth: "throwOnMaxDepth", maxCount: "throwOnMaxCount", writeLimit: "throwOnWriteLimit", totalTaskTimeoutMillis: "throwOnDeadline" }[key]!;
    const issues = issuesOf({ [block]: { [key]: value, [flag]: true } });
    assert.equal(issues.length, 1, `${block}.${key}=${JSON.stringify(value)}`);
    assert.match(issues[0]!, new RegExp(`${block}: ${key} must be an integer`), `${block}.${key}=${JSON.stringify(value)}`);
  }
  for (const flag of ["throwOnMaxDepth", "throwOnMaxCount"]) {
    assert.match(issuesOf({ "embedded-limits": { [flag]: "true" } }).join(";"), new RegExp(`${flag} must be a boolean`));
  }
  assert.match(issuesOf({ "output-limits": { throwOnWriteLimit: 1 } }).join(";"), /throwOnWriteLimit must be a boolean/);
  assert.match(issuesOf({ "timeout-limits": { throwOnDeadline: "yes" } }).join(";"), /throwOnDeadline must be a boolean/);
});

test("every problem is reported at once, with the other sections' problems", () => {
  const issues = validateConfig({
    unknown: true,
    "parse-context": {
      "embedded-limits": { maxDepth: 5 },
      "output-limits": { zipBombRatio: 10, writeLimit: 5 },
      "timeout-limits": { progressTimeoutMillis: 1 },
    },
  });
  assert.equal(issues.length, 5, issues.join("\n"));
});

test("a Tika configuration copied as-is says what to change", () => {
  // The shape Tika's own javadoc shows for each block.
  assert.throws(
    () =>
      loadConfig({
        "parse-context": {
          "embedded-limits": { maxDepth: 10, throwOnMaxDepth: false, maxCount: 1000, throwOnMaxCount: false },
        },
      }),
    (error: unknown) =>
      error instanceof RipstreamConfigError &&
      error.issues.length === 2 &&
      error.issues.every((issue) => /needs throwOn\w+: true/.test(issue)),
  );
});

test("accessors are read once and a proxy cannot show validation one value and the loaded config another", () => {
  let reads = 0;
  const block = {
    get maxCount() {
      return reads++ === 0 ? 5 : 99999;
    },
    throwOnMaxCount: true,
  };
  const config = loadConfig({ "parse-context": { "embedded-limits": block } });
  assert.deepEqual(config.limits, { maxEmbeddedResources: 5 });
  assert.equal(reads, 1);
});
