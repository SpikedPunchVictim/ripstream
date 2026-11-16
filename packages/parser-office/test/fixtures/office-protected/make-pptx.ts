/*
 * Regenerates standard_password.pptx: node packages/parser-office/test/fixtures/office-protected/make-pptx.ts
 * The package is segments/files/deck.pptx of the parsers fixtures, encrypted with the standard (ECMA-376 3.2) scheme, AES-128,
 * password "Password1234_", and wrapped in an OLE2 container. Not a file Office wrote: written from MS-OFFCRYPTO with node:crypto.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildCompound } from "../../ole-builder.ts";
import { standardEncrypted } from "../../office-crypto-builder.ts";

const deck = new Uint8Array(readFileSync(new URL("../../../../parsers/test/fixtures/segments/files/deck.pptx", import.meta.url)));
const { info, encrypted } = standardEncrypted(deck, "Password1234_", 128);
writeFileSync(
  new URL("standard_password.pptx", import.meta.url),
  buildCompound([
    { name: "EncryptionInfo", data: info },
    { name: "EncryptedPackage", data: encrypted },
  ]),
);
