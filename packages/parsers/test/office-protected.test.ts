import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { EncryptedDocumentError } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

const FIXTURES = new URL("../../parser-office/test/fixtures/office-protected/", import.meta.url);
const FILES = [
  "ecma376agile_sha1_password.xlsx",
  "ecma376standard_password.docx",
  "example_password.docx",
  "example_password.xlsx",
];

test("standard and agile OOXML packages decrypt with the supplied password", async () => {
  for (const name of FILES) {
    const bytes = new Uint8Array(await readFile(new URL(name, FIXTURES)));
    const { text } = await createRipstream().parse(bytes, { filename: name, password: "Password1234_" });
    assert.match(text.toLowerCase(), /lorem\s+ipsum/, name);
  }
});

test("an encrypted OOXML package with the wrong password fails as encrypted", async () => {
  const bytes = new Uint8Array(await readFile(new URL(FILES[0]!, FIXTURES)));
  await assert.rejects(
    createRipstream().parse(bytes, { filename: FILES[0]!, password: "not-the-password" }),
    EncryptedDocumentError,
  );
});
