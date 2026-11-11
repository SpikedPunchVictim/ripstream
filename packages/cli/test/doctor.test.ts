import assert from "node:assert/strict";
import { test } from "node:test";
import { runDoctor, type DoctorProbes } from "../src/doctor.ts";

const healthy: DoctorProbes = {
  nodeVersion: "22.18.0",
  canImport: async () => true,
  tesseractVersion: async () => "tesseract 5.3.0",
};

function names(checks: readonly { name: string; status: string }[]): Record<string, string> {
  return Object.fromEntries(checks.map((c) => [c.name, c.status]));
}

test("everything present: all checks ok", async () => {
  const { ok, checks } = await runDoctor(healthy);
  assert.equal(ok, true);
  assert.deepEqual(names(checks), { node: "ok", "pdfjs-dist": "ok", "cld3-asm": "ok", tesseract: "ok" });
});

test("Node older than 22.18 fails, and fails the run", async () => {
  for (const nodeVersion of ["22.17.9", "20.11.0", "18.0.0"]) {
    const { ok, checks } = await runDoctor({ ...healthy, nodeVersion });
    assert.equal(ok, false, nodeVersion);
    assert.equal(names(checks).node, "fail", nodeVersion);
  }
});

test("Node 22.18, 23 and 24 pass", async () => {
  for (const nodeVersion of ["22.18.0", "22.20.1", "23.0.0", "24.1.0"]) {
    assert.equal(names((await runDoctor({ ...healthy, nodeVersion })).checks).node, "ok", nodeVersion);
  }
});

test("a missing optional dependency warns and names what it disables, but the run is still ok", async () => {
  const { ok, checks } = await runDoctor({ ...healthy, canImport: async (name) => name !== "pdfjs-dist" });
  assert.equal(ok, true);
  const pdf = checks.find((c) => c.name === "pdfjs-dist");
  assert.equal(pdf?.status, "warn");
  assert.match(pdf?.detail ?? "", /PDF/);
});

test("tesseract not on PATH warns", async () => {
  const { ok, checks } = await runDoctor({ ...healthy, tesseractVersion: async () => null });
  assert.equal(ok, true);
  assert.equal(names(checks).tesseract, "warn");
});
