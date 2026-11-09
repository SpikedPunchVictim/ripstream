import assert from "node:assert/strict";
import { test } from "node:test";
import { IsolationSettingsError, resolveIsolationConfig, resolveMaxOutputChars } from "../src/isolation-config.ts";

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
