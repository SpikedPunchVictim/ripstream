import assert from "node:assert/strict";
import { test } from "node:test";
import { probeIsolation } from "../src/probe.ts";
import { containmentFor } from "../src/containment.ts";
import { CHILD } from "./fixtures/helpers.ts";

test("probe passes on a healthy machine and reports this platform's containment", async () => {
  const result = await probeIsolation();
  assert.deepEqual(result, { available: true, containment: containmentFor() });
});

test("probe with the production vmem value passes on Linux", { skip: process.platform !== "linux" }, async () => {
  const result = await probeIsolation({ vmemKb: 6_291_456 });
  assert.equal(result.available, true);
});

test("a missing node binary is available:false with a reason, never a throw", async () => {
  const result = await probeIsolation({ nodePath: "/nonexistent/node" });
  assert.equal(result.available, false);
  assert.match(!result.available ? result.reason : "", /probe failed.*before it was ready/);
});

test("a probe child that never gets ready is unavailable within the ready/overall budget", async () => {
  const started = performance.now();
  const result = await probeIsolation({ probeScript: CHILD, probeScriptArgs: ["never-ready"], timeoutMs: 600 });
  assert.equal(result.available, false);
  assert.ok(performance.now() - started < 5000);
});

test("a probe child that fails before ready (bad script path) is unavailable", async () => {
  const result = await probeIsolation({ probeScript: "/nonexistent/probe.js" });
  assert.equal(result.available, false);
});

test("invalid inputs are available:false, not a throw", async () => {
  const result = await probeIsolation({ cpuSecs: -5 });
  assert.equal(result.available, false);
  assert.match(!result.available ? result.reason : "", /cpuSecs/);
});

test("a probe child that answers wrongly is unavailable", async () => {
  // fixtures/child.ts "echo" returns the input as text, which is not the probe answer.
  const result = await probeIsolation({ probeScript: CHILD, probeScriptArgs: ["echo"] });
  assert.equal(result.available, false);
  assert.match(!result.available ? result.reason : "", /unexpected answer/);
});
