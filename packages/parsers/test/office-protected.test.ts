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
    // Tika 4.2.0 (no password): EncryptedDocumentException "Unable to process: document is encrypted" (tikajs-cigc).
    (error) => error instanceof EncryptedDocumentError && error.message === "Unable to process: document is encrypted",
  );
});

// tikajs-2gsr: a password-protected pptx (standard encryption, AES-128, password "Password1234_"; see make-pptx.ts beside it).
// Oracle Tika 4.2.0 /rmeta on the file with no password: tk:encrypted=true and tk:exception:container-exception =
// "EncryptedDocumentException: Unable to process: document is encrypted", no content. Tika's REST server has no password to give,
// so the right password is checked against the text of the deck the file was made from (segments/files/deck.pptx).
const PPTX = "standard_password.pptx";
const pptx = async (): Promise<Uint8Array> => new Uint8Array(await readFile(new URL(PPTX, FIXTURES)));
const encrypted = (error: unknown): boolean =>
  error instanceof EncryptedDocumentError && error.message === "Unable to process: document is encrypted";

test("a password-protected pptx is read with the right password", async () => {
  const { text } = await createRipstream().parse(await pptx(), { filename: PPTX, password: "Password1234_" });
  assert.match(text, /PLANTED-PPTX-BODY/);
  assert.match(text, /PLANTED-PPTX-NOTES/);
});

test("a password-protected pptx with the wrong password fails as encrypted", async () => {
  await assert.rejects(createRipstream().parse(await pptx(), { filename: PPTX, password: "not-the-password" }), encrypted);
});

test("a password-protected pptx with no password fails as encrypted", async () => {
  await assert.rejects(createRipstream().parse(await pptx(), { filename: PPTX }), encrypted);
});
