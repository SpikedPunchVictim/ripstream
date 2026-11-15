import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IsolationSettingsError,
  assertKnownVariables,
  resolveIsolationConfig,
  resolveMaxOutputChars,
} from "../src/isolation-config.ts";

const none = { flagMode: null, env: {}, fileIsolation: null } as const;

test("the command decides the default mode: serve is strict, one-shot commands are off", () => {
  assert.deepEqual(resolveIsolationConfig({ ...none, defaultMode: "strict" }), { config: { mode: "strict" }, modeSource: "default" });
  assert.deepEqual(resolveIsolationConfig({ ...none, defaultMode: "off" }), { config: { mode: "off" }, modeSource: "default" });
});

test("mode precedence: flag over env over config file over default", () => {
  const file = { mode: "lenient" } as const;
  assert.deepEqual(resolveIsolationConfig({ defaultMode: "strict", flagMode: null, env: {}, fileIsolation: file }).modeSource, "config");
  const env = { RIPSTREAM_ISOLATION: "off" };
  assert.deepEqual(resolveIsolationConfig({ defaultMode: "strict", flagMode: null, env, fileIsolation: file }), {
    config: { mode: "off" },
    modeSource: "env",
  });
  assert.deepEqual(resolveIsolationConfig({ defaultMode: "off", flagMode: "strict", env, fileIsolation: file }), {
    config: { mode: "strict" },
    modeSource: "flag",
  });
});

test("numeric settings come from the file and are overridden per field by the environment", () => {
  const result = resolveIsolationConfig({
    defaultMode: "strict",
    flagMode: null,
    fileIsolation: { mode: "strict", memoryPoolMb: 4000, perChildMb: 1536, maxQueue: 4 },
    env: {
      RIPSTREAM_ISOLATION_MEMORY_POOL_MB: "8000",
      RIPSTREAM_ISOLATION_MAX_TASK_MILLIS: "30000",
      RIPSTREAM_ISOLATION_MAX_INPUT_BYTES: "1048576",
      RIPSTREAM_ISOLATION_HEAP_MB: "512",
    },
  });
  assert.deepEqual(result.config, {
    mode: "strict",
    memoryPoolMb: 8000,
    perChildMb: 1536,
    maxQueue: 4,
    maxTaskMillis: 30000,
    maxInputBytes: 1048576,
    heapMb: 512,
  });
});

test("maxDiskMb comes from RIPSTREAM_ISOLATION_MAX_DISK_MB or the file's isolation.maxDiskMb, the variable winning", () => {
  assert.equal(
    resolveIsolationConfig({ ...none, defaultMode: "strict", env: { RIPSTREAM_ISOLATION_MAX_DISK_MB: "512" } }).config.maxDiskMb,
    512,
  );
  assert.equal(
    resolveIsolationConfig({ ...none, defaultMode: "strict", fileIsolation: { mode: "strict", maxDiskMb: 256 } }).config.maxDiskMb,
    256,
  );
  assert.equal(
    resolveIsolationConfig({
      ...none,
      defaultMode: "strict",
      fileIsolation: { mode: "strict", maxDiskMb: 256 },
      env: { RIPSTREAM_ISOLATION_MAX_DISK_MB: "2048" },
    }).config.maxDiskMb,
    2048,
  );
});

test("requireStrictContainment comes from the environment or the file", () => {
  assert.equal(
    resolveIsolationConfig({ ...none, defaultMode: "strict", env: { RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT: "true" } }).config
      .requireStrictContainment,
    true,
  );
  assert.equal(
    resolveIsolationConfig({
      ...none,
      defaultMode: "strict",
      fileIsolation: { mode: "strict", requireStrictContainment: true },
      env: { RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT: "0" },
    }).config.requireStrictContainment,
    false,
  );
});

test("a bad value names where it came from", () => {
  const cases: Array<[Partial<Parameters<typeof resolveIsolationConfig>[0]>, RegExp]> = [
    [{ flagMode: "paranoid" }, /--isolation.*strict, lenient or off/],
    [{ env: { RIPSTREAM_ISOLATION: "yes" } }, /RIPSTREAM_ISOLATION.*strict, lenient or off/],
    [{ env: { RIPSTREAM_ISOLATION_MEMORY_POOL_MB: "lots" } }, /RIPSTREAM_ISOLATION_MEMORY_POOL_MB.*integer/],
    [{ env: { RIPSTREAM_ISOLATION_MAX_QUEUE: "-1" } }, /RIPSTREAM_ISOLATION_MAX_QUEUE.*integer/],
    [{ env: { RIPSTREAM_ISOLATION_MAX_DISK_MB: "lots" } }, /RIPSTREAM_ISOLATION_MAX_DISK_MB expects a non-negative integer, got "lots"/],
    [{ env: { RIPSTREAM_ISOLATION_MAX_DISK_MB: "1.5" } }, /RIPSTREAM_ISOLATION_MAX_DISK_MB.*integer/],
    [{ env: { RIPSTREAM_ISOLATION_MAX_DISK_MB: "0" } }, /maxDiskMb/],
    [{ env: { RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT: "maybe" } }, /REQUIRE_STRICT_CONTAINMENT.*true or false/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(() => resolveIsolationConfig({ ...none, defaultMode: "strict", ...overrides }), (error: unknown) => {
      assert.ok(error instanceof IsolationSettingsError, String(error));
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test("the merged settings are validated as a whole, with core's rules", () => {
  assert.throws(
    () =>
      resolveIsolationConfig({
        ...none,
        defaultMode: "strict",
        env: { RIPSTREAM_ISOLATION_MEMORY_POOL_MB: "1000", RIPSTREAM_ISOLATION_PER_CHILD_MB: "2000" },
      }),
    (error: unknown) => error instanceof IsolationSettingsError && /perChildMb must not exceed.*memoryPoolMb/.test(error.message),
  );
});

test("requireStrictContainment only applies to strict: a lower mode from any source drops it instead of failing", () => {
  const strictEnv = { RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT: "true" };
  // The command default (one-shot commands are off), the flag and RIPSTREAM_ISOLATION can each lower the mode.
  assert.deepEqual(resolveIsolationConfig({ ...none, defaultMode: "off", env: strictEnv }).config, { mode: "off" });
  assert.deepEqual(resolveIsolationConfig({ ...none, defaultMode: "strict", flagMode: "lenient", env: strictEnv }).config, { mode: "lenient" });
  assert.deepEqual(
    resolveIsolationConfig({ ...none, defaultMode: "strict", env: { ...strictEnv, RIPSTREAM_ISOLATION: "off" } }).config,
    { mode: "off" },
  );
  assert.deepEqual(
    resolveIsolationConfig({
      ...none,
      defaultMode: "strict",
      flagMode: "off",
      fileIsolation: { mode: "strict", requireStrictContainment: true },
    }).config,
    { mode: "off" },
  );
  // Under strict it is kept.
  assert.equal(resolveIsolationConfig({ ...none, defaultMode: "strict", env: strictEnv }).config.requireStrictContainment, true);
});

test("unrelated environment variables are ignored", () => {
  assert.deepEqual(resolveIsolationConfig({ ...none, defaultMode: "off", env: { PATH: "/bin", RIPSTREAM_OTHER: "1" } }).config, { mode: "off" });
});

test("maxOutputChars: flag over environment; absent is null; bad values are refused", () => {
  assert.equal(resolveMaxOutputChars({ flag: null, env: {} }), null);
  assert.equal(resolveMaxOutputChars({ flag: null, env: { RIPSTREAM_MAX_OUTPUT_CHARS: "500" } }), 500);
  assert.equal(resolveMaxOutputChars({ flag: "900", env: { RIPSTREAM_MAX_OUTPUT_CHARS: "500" } }), 900);
  for (const flag of ["-1", "0x10", "1.5", "", "abc"]) {
    assert.throws(() => resolveMaxOutputChars({ flag, env: {} }), IsolationSettingsError, flag);
  }
  assert.throws(() => resolveMaxOutputChars({ flag: null, env: { RIPSTREAM_MAX_OUTPUT_CHARS: "x" } }), /RIPSTREAM_MAX_OUTPUT_CHARS/);
});

/*
 * A RIPSTREAM_* name that is misspelled used to be ignored (tasks/parity/audits/config-inventory.json, C18): the setting
 * it was meant to be fell back to its default, and for a limit that is a different limit from the one asked for.
 */

test("a RIPSTREAM_ name that is not a setting is refused, with the nearest setting as the hint", () => {
  const refusal = (name: string): string => {
    try {
      assertKnownVariables({ [name]: "1" });
    } catch (error) {
      assert.ok(error instanceof IsolationSettingsError, name);
      return error.message;
    }
    assert.fail(`${name} was accepted`);
  };
  assert.match(refusal("RIPSTREAM_ISOLATION_MAXQUEUE"), /RIPSTREAM_ISOLATION_MAXQUEUE.*did you mean RIPSTREAM_ISOLATION_MAX_QUEUE\?/);
  assert.match(refusal("RIPSTREAM_ISOLATON"), /did you mean RIPSTREAM_ISOLATION\?/);
  assert.match(refusal("RIPSTREAM_MAX_OUTPUT_CHAR"), /did you mean RIPSTREAM_MAX_OUTPUT_CHARS\?/);
  assert.match(refusal("RIPSTREAM_ISOLATION_PERCHILD_MB"), /did you mean RIPSTREAM_ISOLATION_PER_CHILD_MB\?/);
  // A name near nothing is still refused, without a made-up hint.
  assert.doesNotMatch(refusal("RIPSTREAM_TOTALLY_DIFFERENT_THING"), /did you mean/);
});

test("every unknown name is listed, not only the first", () => {
  assert.throws(
    () => assertKnownVariables({ RIPSTREAM_ONE: "1", RIPSTREAM_TWO: "2" }),
    (error: unknown) => error instanceof IsolationSettingsError && /RIPSTREAM_ONE/.test(error.message) && /RIPSTREAM_TWO/.test(error.message),
  );
});

test("every setting the CLI reads is accepted; so are names that do not start with RIPSTREAM_", () => {
  assertKnownVariables({
    RIPSTREAM_ISOLATION: "off",
    RIPSTREAM_ISOLATION_MEMORY_POOL_MB: "1",
    RIPSTREAM_ISOLATION_PER_CHILD_MB: "1",
    RIPSTREAM_ISOLATION_MAX_INPUT_BYTES: "1",
    RIPSTREAM_ISOLATION_MAX_TASK_MILLIS: "1",
    RIPSTREAM_ISOLATION_HEAP_MB: "1",
    RIPSTREAM_ISOLATION_MAX_QUEUE: "1",
    RIPSTREAM_ISOLATION_MAX_DISK_MB: "1",
    RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT: "true",
    RIPSTREAM_ISOLATION_REUSE: "true",
    RIPSTREAM_ISOLATION_REUSE_TRUST_DOMAIN: "tenant",
    RIPSTREAM_ISOLATION_REUSE_MAX_REQUESTS: "1",
    RIPSTREAM_ISOLATION_REUSE_RSS_CEILING_MB: "1",
    RIPSTREAM_ISOLATION_REUSE_RSS_SAMPLE_EVERY: "1",
    RIPSTREAM_ISOLATION_REUSE_IDLE_TIMEOUT_MS: "1",
    RIPSTREAM_ISOLATION_REUSE_MAX_IDLE_CHILDREN: "1",
    RIPSTREAM_ISOLATION_REUSE_MAX_TRUST_DOMAINS: "1",
    RIPSTREAM_MAX_OUTPUT_CHARS: "1",
    PATH: "/bin",
    ripstream_lowercase: "x",
    MY_RIPSTREAM_THING: "x",
  });
});

test("RIPSTREAM_PDFJS_CORPUS belongs to the test suite and is not refused", () => {
  assertKnownVariables({ RIPSTREAM_PDFJS_CORPUS: "/corpus" });
});

test("the variables the CLI reads are exactly the ones accepted", () => {
  // resolveIsolationConfig reads each of these; if one were added there and not to the accepted list, setting it
  // would be refused as unknown.
  const every = {
    RIPSTREAM_ISOLATION: "strict",
    RIPSTREAM_ISOLATION_MEMORY_POOL_MB: "4000",
    RIPSTREAM_ISOLATION_PER_CHILD_MB: "1536",
    RIPSTREAM_ISOLATION_MAX_INPUT_BYTES: "1048576",
    RIPSTREAM_ISOLATION_MAX_TASK_MILLIS: "30000",
    RIPSTREAM_ISOLATION_HEAP_MB: "512",
    RIPSTREAM_ISOLATION_MAX_QUEUE: "4",
    RIPSTREAM_ISOLATION_MAX_DISK_MB: "512",
    RIPSTREAM_ISOLATION_REQUIRE_STRICT_CONTAINMENT: "true",
  };
  assertKnownVariables(every);
  assert.equal(resolveIsolationConfig({ ...none, defaultMode: "off", env: every }).config.maxQueue, 4);
});

const strictNone = { ...none, defaultMode: "strict" as const, reuseApplies: true };

test("reuse is off by default: no reuse in the result and none in the isolator's config", () => {
  const resolved = resolveIsolationConfig(strictNone);
  assert.equal(resolved.reuse, undefined);
  assert.equal(resolved.reuseSource, undefined);
  assert.equal("reuse" in resolved.config, false);
});

test("--isolation-reuse names the trust domain and switches reuse on", () => {
  const resolved = resolveIsolationConfig({ ...strictNone, flagReuseTrustDomain: "tenant-a" });
  assert.deepEqual(resolved.reuse, { enabled: true, trustDomain: "tenant-a" });
  assert.equal(resolved.reuseSource, "flag");
  assert.equal("reuse" in resolved.config, false);
});

test("--isolation-reuse-max-requests sets a detail of reuse that the flag switched on", () => {
  const resolved = resolveIsolationConfig({ ...strictNone, flagReuseTrustDomain: "t", flagReuseMaxRequests: "50" });
  assert.deepEqual(resolved.reuse, { enabled: true, trustDomain: "t", maxRequests: 50 });
});

test("reuse from the environment needs RIPSTREAM_ISOLATION_REUSE=true and a trust domain", () => {
  const env = { RIPSTREAM_ISOLATION_REUSE: "true", RIPSTREAM_ISOLATION_REUSE_TRUST_DOMAIN: "d", RIPSTREAM_ISOLATION_REUSE_MAX_REQUESTS: "7" };
  const resolved = resolveIsolationConfig({ ...strictNone, env });
  assert.deepEqual(resolved.reuse, { enabled: true, trustDomain: "d", maxRequests: 7 });
  assert.equal(resolved.reuseSource, "env");
});

test("reuse from the config file, with the environment and the flag overriding per field", () => {
  const fileIsolation = { mode: "strict", reuse: { enabled: true, trustDomain: "file", maxRequests: 10, idleTimeoutMs: 5000 } } as const;
  assert.equal(resolveIsolationConfig({ ...strictNone, fileIsolation }).reuseSource, "config");
  const resolved = resolveIsolationConfig({
    ...strictNone,
    fileIsolation,
    env: { RIPSTREAM_ISOLATION_REUSE_MAX_REQUESTS: "20", RIPSTREAM_ISOLATION_REUSE_TRUST_DOMAIN: "env" },
    flagReuseTrustDomain: "flag",
    flagReuseMaxRequests: "30",
  });
  assert.deepEqual(resolved.reuse, { enabled: true, trustDomain: "flag", maxRequests: 30, idleTimeoutMs: 5000 });
  assert.equal(resolved.reuseSource, "flag");
});

test("RIPSTREAM_ISOLATION_REUSE=false turns off what the config file switched on", () => {
  const fileIsolation = { mode: "strict", reuse: { enabled: true, trustDomain: "file" } } as const;
  const resolved = resolveIsolationConfig({ ...strictNone, fileIsolation, env: { RIPSTREAM_ISOLATION_REUSE: "false" } });
  assert.equal(resolved.reuse, undefined);
});

test("reuse without a trust domain is refused and says how to name one", () => {
  assert.throws(
    () => resolveIsolationConfig({ ...strictNone, env: { RIPSTREAM_ISOLATION_REUSE: "true" } }),
    (error: unknown) => error instanceof IsolationSettingsError && /trust domain/.test(error.message) && /--isolation-reuse <trust-domain>/.test(error.message),
  );
  assert.throws(
    () => resolveIsolationConfig({ ...strictNone, fileIsolation: { mode: "strict", reuse: { enabled: true } } }),
    (error: unknown) => error instanceof IsolationSettingsError && /trust domain/.test(error.message),
  );
});

test("an empty trust domain is refused", () => {
  assert.throws(() => resolveIsolationConfig({ ...strictNone, flagReuseTrustDomain: "" }), IsolationSettingsError);
});

test("reuse is refused while isolation is off: there are no children to reuse", () => {
  assert.throws(
    () => resolveIsolationConfig({ ...strictNone, defaultMode: "off", flagReuseTrustDomain: "t" }),
    (error: unknown) => error instanceof IsolationSettingsError && /isolation mode is off/.test(error.message),
  );
});

test("a detail of reuse without reuse switched on is refused, not ignored", () => {
  assert.throws(
    () => resolveIsolationConfig({ ...strictNone, flagReuseMaxRequests: "5" }),
    (error: unknown) => error instanceof IsolationSettingsError && /not switched on/.test(error.message),
  );
  assert.throws(
    () => resolveIsolationConfig({ ...strictNone, env: { RIPSTREAM_ISOLATION_REUSE_MAX_REQUESTS: "5" } }),
    (error: unknown) => error instanceof IsolationSettingsError && /RIPSTREAM_ISOLATION_REUSE_MAX_REQUESTS/.test(error.message),
  );
});

test("a bad reuse number names where it came from and core's rules apply to the merged result", () => {
  assert.throws(
    () => resolveIsolationConfig({ ...strictNone, flagReuseTrustDomain: "t", flagReuseMaxRequests: "many" }),
    (error: unknown) => error instanceof IsolationSettingsError && /--isolation-reuse-max-requests/.test(error.message),
  );
  assert.throws(
    () => resolveIsolationConfig({ ...strictNone, flagReuseTrustDomain: "t", flagReuseMaxRequests: "0" }),
    (error: unknown) => error instanceof IsolationSettingsError && /maxRequests/.test(error.message),
  );
});

test("a command that parses one document refuses the reuse flags and ignores the variables", () => {
  assert.throws(
    () => resolveIsolationConfig({ ...strictNone, reuseApplies: false, flagReuseTrustDomain: "t" }),
    (error: unknown) => error instanceof IsolationSettingsError && /serve and pipes/.test(error.message),
  );
  const resolved = resolveIsolationConfig({ ...strictNone, reuseApplies: false, env: { RIPSTREAM_ISOLATION_REUSE: "true" } });
  assert.equal(resolved.reuse, undefined);
});
