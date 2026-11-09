import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { blockPdfjsCanvas, isPdfjsCanvasRequest } from "../src/block-pdfjs-canvas.ts";

const CANVAS = "@napi-rs/canvas";

test("only pdfjs-dist asking for the canvas is blocked", () => {
  const inPdfjs = "file:///app/node_modules/.pnpm/pdfjs-dist@4.10.38/node_modules/pdfjs-dist/legacy/build/pdf.mjs";
  assert.equal(isPdfjsCanvasRequest(CANVAS, inPdfjs), true);
  assert.equal(isPdfjsCanvasRequest(CANVAS, "file:///app/src/render.ts"), false, "the application's own canvas");
  assert.equal(isPdfjsCanvasRequest(CANVAS, undefined), false);
  assert.equal(isPdfjsCanvasRequest("@napi-rs/canvas-linux-arm64-gnu", inPdfjs), false, "another module from pdf.js");
  assert.equal(isPdfjsCanvasRequest("node:fs", inPdfjs), false);
});

// The require pdf.js makes at import time, made from the real pdfjs-dist. Needs the canvas to be installed: it is an
// optional dependency of pdfjs-dist, so a platform without a binding has nothing to block.
const parserPdf = join(dirname(fileURLToPath(import.meta.url)), "../../parser-pdf/package.json");
const pdfjsEntry = join(dirname(createRequire(parserPdf).resolve("pdfjs-dist/package.json")), "legacy/build/pdf.mjs");
const fromPdfjs = createRequire(pathToFileURL(pdfjsEntry));
const canvasInstalled = ((): boolean => {
  try {
    fromPdfjs.resolve(CANVAS);
    return true;
  } catch {
    return false;
  }
})();

test("the block makes the canvas unresolvable for pdf.js and can be taken off", { skip: canvasInstalled ? false : "no @napi-rs/canvas binding on this platform" }, () => {
  const block = blockPdfjsCanvas();
  try {
    assert.throws(() => fromPdfjs(CANVAS), { code: "MODULE_NOT_FOUND" });
  } finally {
    block.deregister();
  }
  assert.doesNotThrow(() => fromPdfjs.resolve(CANVAS), "resolvable again after deregister");
});
