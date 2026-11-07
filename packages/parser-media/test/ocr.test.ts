import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType } from "@spikedpunch/ripstream-core";
import { TesseractOcrParser } from "../src/index.ts";

test("Tesseract parser advertises image OCR types", () => {
  const types = new TesseractOcrParser().getSupportedTypes();
  assert.ok(types.has(MediaType.parse("image/png")!));
  assert.ok(types.has(MediaType.parse("image/jpeg")!));
});
