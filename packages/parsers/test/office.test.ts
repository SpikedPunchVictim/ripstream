import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { createRipstream } from "../src/index.ts";

const ripstream = createRipstream();

function packageOf(files: Record<string, string>): Uint8Array {
  const archive: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) archive[name] = strToU8(value);
  return zipSync(archive);
}

test("detects and parses docx end to end", async () => {
  const docx = packageOf({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml":
      '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>',
  });
  const result = await ripstream.parse(docx, { filename: "sample.docx" });
  assert.equal(
    result.metadata.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.match(result.text, /Hello DOCX/);
});

test("detects and parses ODT end to end", async () => {
  const odt = packageOf({
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml":
      '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>Hello ODT</text:p></office:text></office:body></office:document-content>',
  });
  const result = await ripstream.parse(odt, { filename: "sample.odt" });
  assert.equal(
    result.metadata.get("Content-Type"),
    "application/vnd.oasis.opendocument.text",
  );
  assert.match(result.text, /Hello ODT/);
});
