import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/*
 * pdf.js writes its warnings with console.log, which is stdout (tikajs-08ld): "Cannot load @napi-rs/canvas" and
 * "Cannot polyfill ..." as it loads, "Indexing all PDF objects" for a PDF with no usable xref. The command's stdout is
 * the document's text and nothing else.
 */

/** A PDF cut before its xref and trailer: pdf.js indexes the objects itself, and says so. */
const CUT_PDF =
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
  "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n" +
  "4 0 obj\n<< /Length 59 >>\nstream\nBT /F1 24 Tf 72 700 Td (Recovered before the trailer) Tj ET\nendstream\nendobj\n" +
  "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

for (const isolation of ["off", "strict"]) {
  test(`parse of a PDF that makes pdf.js warn prints only its text on stdout, isolation ${isolation} (tikajs-08ld)`, () => {
    const directory = mkdtempSync(join(tmpdir(), "ripstream-cli-pdf-stdout-"));
    try {
      const file = join(directory, "cut.pdf");
      writeFileSync(file, CUT_PDF, "latin1");
      const run = spawnSync(process.execPath, ["packages/cli/bin/ripstream.js", "parse", "--isolation", isolation, file], {
        cwd: new URL("../../..", import.meta.url).pathname,
        // The per-file build: the bundle, when it is built, is a copy of the code from when it was built.
        env: { ...process.env, RIPSTREAM_NO_BUNDLE: "1" },
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), "Recovered before the trailer");
      assert.doesNotMatch(run.stdout, /Warning:/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
