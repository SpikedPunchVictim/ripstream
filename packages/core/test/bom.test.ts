import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeText, detectEncoding } from "../../mime/src/text-encoding.ts";

test("BOM stripping and detection are consistent", () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
  assert.equal(detectEncoding(bytes).bom, true);
  assert.equal(decodeText(bytes, "UTF-8"), "A");
});
