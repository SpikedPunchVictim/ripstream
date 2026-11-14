import assert from "node:assert/strict";
import { test } from "node:test";
import { repairPdf } from "../src/pdf-repair.ts";

const decoder = new TextDecoder("latin1");

test("repairPdf rewrites the xref and trailer for a file cut before its trailer", () => {
  const source = new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
  );
  const repaired = repairPdf(source);
  assert.notEqual(repaired, null);
  const text = decoder.decode(repaired!);
  assert.match(text, /xref\n0 3\n/);
  assert.match(text, /trailer\n<< \/Size 3 \/Root 1 0 R >>/);
  assert.match(text, /startxref\n\d+\n%%EOF\n$/);
});

test("repairPdf refuses an encrypted document and one with no catalog", () => {
  assert.equal(repairPdf(new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Encrypt 2 0 R >>\nendobj\n")), null);
  assert.equal(repairPdf(new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Font >>\nendobj\n")), null);
});
