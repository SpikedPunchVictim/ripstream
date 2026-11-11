import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MediaType, ParseContext } from "@spikedpunch/ripstream-core";
import { createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * The TSD parser as the facade and the default parser list see it (tikajs-68os.21). Split from tsd.test.ts so that the file
 * the mutation runs use constructs the parser directly and loads no other parser's registration.
 */

const TSD = "application/timestamped-data";

const file = (name: string): Uint8Array => readFileSync(new URL(`./fixtures/timestamped-data/${name}`, import.meta.url));

test("the TSD parser is the exact match for application/timestamped-data", async () => {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow(TSD), new ParseContext());
  assert.deepEqual(
    matches.slice(0, 1).map((match) => ({ name: match.parser.name, kind: match.kind })),
    [{ name: "TSDParser", kind: "exact" }],
  );
});

for (const [name, count] of [
  ["Test1.txt.tsd", 2],
  ["Test2.txt.tsd", 2],
  ["Test3.docx.tsd", 2],
  ["Test4.pdf.tsd", 2],
] as const) {
  test(`${name}: the envelope and the stamped file are two documents, the envelope parsed by TSDParser`, async () => {
    const records = await createRipstream().parseRecursive(file(name), { filename: name });
    assert.equal(records.length, count);
    assert.ok(records[0]!.metadata.getAll("tk:parsed-by").includes("TSDParser"));
  });
}

test("MANIFEST.XML.TSD: three documents, as Tika counts them (testTSDFileDataRecursiveMetadataXML)", async () => {
  // The envelope, the PKCS#7 file it holds, and the signed XML inside that file (tikajs-68os.70).
  const records = await createRipstream().parseRecursive(file("MANIFEST.XML.TSD"), { filename: "MANIFEST.XML.TSD" });
  assert.equal(records.length, 3);
  assert.ok(records[0]!.metadata.getAll("tk:parsed-by").includes("TSDParser"));
  assert.ok(records[1]!.metadata.getAll("tk:parsed-by").includes("Pkcs7Parser"));
  assert.equal(records[1]!.metadata.get("Content-Type"), "application/pkcs7-mime; smime-type=signed-data");
  assert.equal(records[2]!.metadata.get("Content-Type"), "application/xml");
});

test("testTSD_broken_pdf.tsd: the PDF is the embedded document and the cut is recorded on it (testBrokenPdf)", async () => {
  const records = await createRipstream().parseRecursive(file("testTSD_broken_pdf.tsd"), { filename: "testTSD_broken_pdf.tsd" });
  assert.equal(records.length, 2);
  assert.equal(records[1]!.metadata.get("Content-Type"), "application/pdf");
  const recorded = records[1]!.metadata.get("tk:exception:embedded-stream-exception");
  assert.notEqual(recorded, null);
  // Tika's text is "EOFException"; this reader names the cut in its own words.
  assert.match(recorded ?? "", /cut short/);
});
