import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { indexObjects, MAX_INDEX_DECODED_BYTES } from "../src/pdf-objects.ts";
import { PdfSession } from "../src/pdf-session.ts";
import { diagnosePdf, findCatalog, latin1 } from "../src/pdf-rebuild.ts";
import { objectStreamPdf } from "./fixtures.ts";

/**
 * tikajs-hjuh: the index budget was charged for the decoded object stream and again for every member, so a stream that
 * decoded to more than half of it lost its last members, the catalog among them, and an intact file read as damaged.
 */

const MIB = 1024 * 1024;

/** A file of one object stream (object 5) of `count` members; its decoded data is `decoded`, opening with a header of `first` bytes. */
function objectStreamFile(count: number, decoded: string, first: number): string {
  const data = deflateSync(Buffer.from(decoded, "latin1")).toString("latin1");
  return `%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N ${count} /First ${first} /Filter /FlateDecode /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
}

test("an object stream decoding to more than half the budget keeps every member, the catalog last among them", () => {
  const text = latin1(objectStreamPdf(60_000, true));
  const decodedBytes = 60_000 * 152;
  assert.ok(decodedBytes > MAX_INDEX_DECODED_BYTES / 2, "the stream must be over half the budget for this test to mean anything");
  const index = indexObjects(text);
  assert.equal(index.inlined, 60_006);
  assert.deepEqual(index.badObjectStreams, []);
  assert.notEqual(findCatalog(index), null);
  assert.deepEqual(diagnosePdf(text, index).causes, []);
});

test("an intact file with such an object stream opens without a repair", async () => {
  const session = new PdfSession({ data: objectStreamPdf(60_000, true) });
  try {
    const ready = await session.open();
    assert.equal(ready.type, "ready");
    if (ready.type !== "ready") return;
    assert.equal(ready.repair, undefined);
    assert.equal(ready.hasMarkedContent, true);
  } finally {
    await session.dispose();
  }
});

test("an object stream that inflates past the budget is refused, not read in part", () => {
  const body = "x".repeat(MAX_INDEX_DECODED_BYTES + MIB);
  const header = "1 0 ";
  const text = objectStreamFile(1, header + body, header.length);
  const index = indexObjects(text);
  assert.deepEqual(index.badObjectStreams, [5]);
  assert.equal(index.inlined, 0);
});

test("members that each claim the whole stream are charged beyond the decoded length, and stop at the budget", () => {
  // Odd members span the stream (offset 0, the next offset at its end); even ones are empty. Eight members of 6 MiB
  // each, were they all kept, would be 24 MiB of text out of a 6 MiB stream.
  const size = 6 * MIB;
  const header = "1 0 2 " + size + " 3 0 4 " + size + " 5 0 6 " + size + " 7 0 8 " + size + " ";
  const text = objectStreamFile(8, header + "x".repeat(size), header.length);
  const index = indexObjects(text);
  const kept = [...index.objects.values()].filter((object) => object.container === 5).reduce((sum, object) => sum + object.body.length, 0);
  assert.ok(index.inlined < 8, `inlined ${index.inlined} of 8`);
  assert.ok(kept <= MAX_INDEX_DECODED_BYTES, `kept ${kept} bytes`);
  assert.ok(kept > size, "the members the budget allows are still read");
});
