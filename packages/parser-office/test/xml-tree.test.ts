import assert from "node:assert/strict";
import { test } from "node:test";
import { MalformedDocumentError } from "@spikedpunch/ripstream-core";
import { descendantsNamed, parseXmlTree } from "../src/xml-tree.ts";

test("parses ordinary nesting", () => {
  const root = parseXmlTree("<a><b><c/></b></a>");
  assert.equal(descendantsNamed(root, "c").length, 1);
});

test("rejects pathological nesting with MalformedDocumentError", () => {
  const xml = "<a>".repeat(5_000) + "</a>".repeat(5_000);
  assert.throws(() => parseXmlTree(xml), MalformedDocumentError);
});
