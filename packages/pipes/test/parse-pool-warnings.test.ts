import assert from "node:assert/strict";
import { test } from "node:test";
import { LowYieldError } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { statusForParseError } from "../src/index.ts";
import { createParsePool } from "../src/workers.ts";

/** The typed warnings (tikajs-icjf) through the worker pool: they cross as data, and onLowYield is applied on this side. */

/** A one-page PDF that paints an image and shows no text: a scan. */
function scanPdf(): Uint8Array {
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

test("a worker's warnings are the ones a ripstream in this thread gives, and onLowYield: throw is the typed error", async () => {
  const pool = await createParsePool({ workers: 1 });
  try {
    const local = createRipstream();
    const scan = scanPdf();
    const options = { filename: "scan.pdf" };
    const expected = (await local.parse(scan, options)).warnings;
    assert.equal(expected.length, 1);
    assert.deepEqual((await pool.parse(scan, options)).warnings, expected);
    const records = await pool.parseRecursive(scan, options);
    assert.deepEqual(records.map((record) => record.warnings), [expected]);

    const thrown = await pool.parse(scan, { ...options, onLowYield: "throw" }).catch((e: unknown) => e);
    assert.ok(thrown instanceof LowYieldError);
    assert.deepEqual(thrown.warnings, expected);
    assert.ok((await pool.parseRecursive(scan, { ...options, onLowYield: "throw" }).catch((e: unknown) => e)) instanceof LowYieldError);

    const clean = await pool.parse(new TextEncoder().encode("hello"), { filename: "a.txt", onLowYield: "throw" });
    assert.deepEqual(clean.warnings, []);
  } finally {
    await pool.close();
  }
});

test("a LowYieldError is a parse exception that is not emitted, not a crash", () => {
  assert.equal(statusForParseError(new LowYieldError([])), "PARSE_EXCEPTION_NO_EMIT");
});
