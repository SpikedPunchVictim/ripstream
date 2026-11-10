import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMimeType } from "../src/mime-types.ts";
import { extensionFor } from "../src/unpack.ts";

const registry: ServerMimeType[] = [
  { type: "text/plain", extensions: [".txt", ".text"] },
  { type: "image/png", extensions: [".png"] },
  { type: "application/gzip", aliases: ["application/x-gzip"], extensions: [".gz"] },
  { type: "application/x-nothing", extensions: [] },
];

// ---- extensions: Tika's FilenameUtils.calculateExtension(metadata, ".bin") ---------------------------------------

test("extensionFor: the first extension of the registered type, an alias reaching its canonical type", () => {
  assert.equal(extensionFor("text/plain", registry), ".txt");
  assert.equal(extensionFor("image/png", registry), ".png");
  assert.equal(extensionFor("application/x-gzip", registry), ".gz");
  assert.equal(extensionFor("IMAGE/PNG", registry), ".png");
});

test("extensionFor: .bin for no type, an unknown one, one without an extension, or no registry", () => {
  assert.equal(extensionFor(null, registry), ".bin");
  assert.equal(extensionFor("application/x-unknown", registry), ".bin");
  assert.equal(extensionFor("application/x-nothing", registry), ".bin");
  assert.equal(extensionFor("text/plain", undefined), ".bin");
});

test("extensionFor: a Content-Type with parameters is not a registered type to Tika, so it is .bin (r165, r166, r224)", () => {
  assert.equal(extensionFor("text/plain; charset=windows-1252", registry), ".bin");
  assert.equal(extensionFor("text/plain;charset=UTF-8", registry), ".bin");
});

test("extensionFor: an OCR routing type is the image type it came from (EmbeddedDocumentUtil.normalizeMediaType)", () => {
  assert.equal(extensionFor("image/ocr-png", registry), ".png");
  assert.equal(extensionFor("IMAGE/OCR-PNG", registry), ".png");
  assert.equal(extensionFor("image/ocr-unknown", registry), ".bin");
});
