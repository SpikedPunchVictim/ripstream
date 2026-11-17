import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main, type CliIO } from "../src/main.ts";

/** `--on-low-yield` and the warnings in `parse --json` (tikajs-icjf): a scan is recorded by default and refused on request (exit 3). */

function io(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (value) => out.push(value), stderr: (value) => err.push(value), readStdin: async () => new Uint8Array() };
}

function scanPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    "<< /Length 28 >>\nstream\nq 612 0 0 792 0 0 cm /Im1 Do Q\nendstream",
    "<< /Length 1 /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray >>\nstream\n\xff\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-low-yield-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const scan = join(directory, "scan.pdf");
writeFileSync(scan, scanPdf());
const text = join(directory, "a.txt");
writeFileSync(text, "Hello CLI");

test("parse --json lists the warnings of a scan, and a clean document has no warnings field", async () => {
  let sink = io();
  assert.equal(await main(["parse", "--json", scan], sink), 0);
  const written = JSON.parse(sink.out.join("")) as { warnings?: { kind: string }[] };
  assert.deepEqual(written.warnings?.map((warning) => warning.kind), ["image-only"]);

  sink = io();
  assert.equal(await main(["parse", "--json", text], sink), 0);
  assert.equal("warnings" in (JSON.parse(sink.out.join("")) as object), false);
});

test("--on-low-yield throw exits 3 with the LOW_YIELD code, and record writes the result", async () => {
  let sink = io();
  assert.equal(await main(["parse", "--on-low-yield", "throw", scan], sink), 3);
  assert.match(sink.err.join(""), /Low-yield result/);

  sink = io();
  assert.equal(await main(["parse", "--json", "--on-low-yield=throw", scan], sink), 3);
  assert.equal((JSON.parse(sink.err.join("")) as { code: string }).code, "LOW_YIELD");

  sink = io();
  assert.equal(await main(["parse", "-r", "--on-low-yield", "throw", scan], sink), 3);

  assert.equal(await main(["parse", "--on-low-yield", "record", scan], io()), 0);
  assert.equal(await main(["parse", "--on-low-yield", "throw", text], io()), 0);
});

test("the recursive output is what it was: no warnings in the Tika-shaped records", async () => {
  const sink = io();
  assert.equal(await main(["parse", "-r", scan], sink), 0);
  assert.equal(sink.out.join("").includes("warnings"), false);
});

test("--on-low-yield is refused for a value that is neither, and for a command that parses nothing", async () => {
  let sink = io();
  assert.equal(await main(["parse", "--on-low-yield", "sometimes", scan], sink), 2);
  assert.match(sink.err.join(""), /expects record or throw/);
  sink = io();
  assert.equal(await main(["detect", "--on-low-yield", "throw", scan], sink), 2);
  assert.match(sink.err.join(""), /applies to parse/);
});
