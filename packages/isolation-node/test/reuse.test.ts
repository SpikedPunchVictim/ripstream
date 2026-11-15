import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REUSE_IDLE_TIMEOUT_MS,
  DEFAULT_REUSE_MAX_IDLE_CHILDREN,
  DEFAULT_REUSE_MAX_REQUESTS,
  DEFAULT_REUSE_MAX_TRUST_DOMAINS,
  DEFAULT_REUSE_RSS_SAMPLE_EVERY,
  MAX_TRUST_DOMAIN_CHARS,
  requireTrustDomain,
  resolveReuse,
} from "../src/reuse.ts";

const context = { rssLimitMb: 600, platform: "linux" } as const;

test("absent reuse is disabled", () => {
  assert.equal(resolveReuse(undefined, context), null);
});

test("enabled false or omitted is disabled, whatever else is set", () => {
  assert.equal(resolveReuse({}, context), null);
  assert.equal(resolveReuse({ enabled: false, trustDomain: "t", maxRequests: 5 }, context), null);
  assert.equal(resolveReuse({ maxRequests: 5 }, context), null);
});

test("enabled: every default applied; the ceiling is half the RSS kill limit", () => {
  assert.deepEqual(resolveReuse({ enabled: true, trustDomain: "tenant-a" }, context), {
    trustDomain: "tenant-a",
    maxRequests: DEFAULT_REUSE_MAX_REQUESTS,
    rssCeilingMb: 300,
    rssSampleEvery: DEFAULT_REUSE_RSS_SAMPLE_EVERY,
    idleTimeoutMs: DEFAULT_REUSE_IDLE_TIMEOUT_MS,
    maxIdleChildren: DEFAULT_REUSE_MAX_IDLE_CHILDREN,
    maxTrustDomains: DEFAULT_REUSE_MAX_TRUST_DOMAINS,
  });
});

test("enabled: given values are kept and the result is frozen", () => {
  const resolved = resolveReuse(
    { enabled: true, trustDomain: "t", maxRequests: 3, rssCeilingMb: 200, rssSampleEvery: 1, idleTimeoutMs: 50, maxIdleChildren: 2, maxTrustDomains: 1 },
    context,
  );
  assert.deepEqual(resolved, { trustDomain: "t", maxRequests: 3, rssCeilingMb: 200, rssSampleEvery: 1, idleTimeoutMs: 50, maxIdleChildren: 2, maxTrustDomains: 1 });
  assert.ok(Object.isFrozen(resolved));
});

test("enabled without a trust domain is refused", () => {
  assert.throws(() => resolveReuse({ enabled: true }, context), /trustDomain is required/);
});

test("a ceiling at or above the RSS kill limit is refused when enabled", () => {
  assert.throws(() => resolveReuse({ enabled: true, trustDomain: "t", rssCeilingMb: 600 }, context), /below the child's RSS kill limit/);
  assert.equal(resolveReuse({ enabled: false, rssCeilingMb: 600 }, context), null);
});

test("a platform without a CPU measurement cannot enable reuse; disabled is fine there", () => {
  assert.throws(() => resolveReuse({ enabled: true, trustDomain: "t" }, { rssLimitMb: 600, platform: "win32" }), /cannot be enabled on win32/);
  assert.equal(resolveReuse({ enabled: false }, { rssLimitMb: 600, platform: "win32" }), null);
});

test("mistyped keys and bad values fail whichever way the switch is set", () => {
  for (const enabled of [true, false]) {
    assert.throws(() => resolveReuse({ enabled, trustDomain: "t", maxRequest: 5 }, context), /unknown key\(s\) "maxRequest"/);
    for (const key of ["maxRequests", "rssCeilingMb", "rssSampleEvery", "idleTimeoutMs", "maxIdleChildren", "maxTrustDomains"]) {
      for (const bad of [0, -1, 1.5, Number.NaN, "5", null]) {
        assert.throws(() => resolveReuse({ enabled, trustDomain: "t", [key]: bad }, context), RangeError, `${key}=${String(bad)}`);
      }
    }
    assert.throws(() => resolveReuse({ enabled, trustDomain: "" }, context), TypeError);
  }
  assert.throws(() => resolveReuse({ enabled: "yes" }, context), /enabled must be a boolean/);
});

test("reuse that is not an object is refused", () => {
  for (const value of [null, true, "on", [], 1]) assert.throws(() => resolveReuse(value, context), TypeError, String(value));
});

test("requireTrustDomain: a non-empty string up to the maximum length", () => {
  assert.equal(requireTrustDomain("d", "x"), "x");
  assert.equal(requireTrustDomain("d", "x".repeat(MAX_TRUST_DOMAIN_CHARS)), "x".repeat(MAX_TRUST_DOMAIN_CHARS));
  for (const bad of ["", "x".repeat(MAX_TRUST_DOMAIN_CHARS + 1), 5, null, undefined, {}]) {
    assert.throws(() => requireTrustDomain("d", bad), /d must be a non-empty string/);
  }
});
