import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DoctorProbes } from "../src/doctor.ts";
import { main, type CliIO } from "../src/main.ts";

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (v) => out.push(v), stderr: (v) => err.push(v), readStdin: async () => new Uint8Array() };
}

const healthy: DoctorProbes = { nodeVersion: "22.18.0", canImport: async () => true, tesseractVersion: async () => "tesseract 5" };

test("formats lists each media type with its extensions, tab separated", async () => {
  const sink = io();
  assert.equal(await main(["formats"], sink), 0);
  const lines = sink.out.join("").split("\n");
  assert.ok(lines.includes("application/pdf\t.pdf"), "application/pdf with .pdf");
  assert.ok(lines.some((l) => l.startsWith("text/plain\t") && l.includes(".txt")));
});

test("formats --json is the registry as an array of type, aliases, extensions", async () => {
  const sink = io();
  assert.equal(await main(["formats", "--json"], sink), 0);
  const types = JSON.parse(sink.out.join("")) as { type: string; aliases: string[]; extensions: string[] }[];
  const pdf = types.find((t) => t.type === "application/pdf");
  assert.deepEqual(pdf?.extensions.includes(".pdf"), true);
  assert.ok(Array.isArray(pdf?.aliases));
});

test("formats reads the configuration's custom-mimetypes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-formats-"));
  try {
    const mimes = join(directory, "mimes.xml");
    writeFileSync(
      mimes,
      '<?xml version="1.0"?><mime-info><mime-type type="application/x-ripstream-test"><glob pattern="*.rstest"/></mime-type></mime-info>',
    );
    const config = join(directory, "config.json");
    writeFileSync(config, JSON.stringify({ "custom-mimetypes": mimes }));
    const sink = io();
    assert.equal(await main(["formats", "--config", config], sink), 0, sink.err.join(""));
    assert.ok(sink.out.join("").split("\n").includes("application/x-ripstream-test\t.rstest"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor prints one line per check and exits 0 when the requirements are met", async () => {
  const sink = io();
  assert.equal(await main(["doctor"], sink, { doctorProbes: healthy }), 0);
  const text = sink.out.join("");
  assert.match(text, /^ok\s+node\s+22\.18\.0$/m);
  assert.match(text, /^ok\s+tesseract\s+tesseract 5$/m);
});

test("doctor exits 4 (environment) when a requirement fails, and still prints every check", async () => {
  const sink = io();
  assert.equal(await main(["doctor"], sink, { doctorProbes: { ...healthy, nodeVersion: "20.0.0" } }), 4);
  assert.match(sink.out.join(""), /^fail\s+node/m);
  assert.match(sink.out.join(""), /^ok\s+pdfjs-dist/m);
});

test("doctor exits 0 with a warning when an optional dependency is missing", async () => {
  const sink = io();
  assert.equal(await main(["doctor"], sink, { doctorProbes: { ...healthy, canImport: async () => false } }), 0);
  assert.match(sink.out.join(""), /^warn\s+pdfjs-dist\s+not installed: PDF parsing is unavailable$/m);
});

test("doctor --json is { ok, checks }", async () => {
  const sink = io();
  assert.equal(await main(["doctor", "--json"], sink, { doctorProbes: healthy }), 0);
  const report = JSON.parse(sink.out.join("")) as { ok: boolean; checks: { name: string; status: string }[] };
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((c) => c.name), ["node", "pdfjs-dist", "cld3-asm", "tesseract"]);
});

test("with the real machine, doctor runs and reports node as ok", async () => {
  const sink = io();
  const code = await main(["doctor", "--json"], sink);
  const report = JSON.parse(sink.out.join("")) as { checks: { name: string; status: string }[] };
  assert.equal(report.checks.find((c) => c.name === "node")?.status, "ok");
  assert.ok(code === 0 || code === 4);
});
