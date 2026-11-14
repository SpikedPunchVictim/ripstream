import assert from "node:assert/strict";
import { test } from "node:test";
import { lines, type PdfTextItem } from "../src/pdf-lines.ts";

// Oracle (Tika 4.2.0 /tika on the PDFs these items come from, whitespace-collapsed): a "W" and an "elcome" in two fonts on
// one baseline read "Welcome"; "Hello" and "World" 80 points apart read "Hello World"; three runs on baselines 0.4 point
// apart read "aaa bbb ccc" in stream order; a run that ends where the next starts reads without a space.
const item = (str: string, x: number, y: number, width: number, height = 12): PdfTextItem => ({ str, transform: [12, 0, 0, 12, x, y], width, height });

test("a mid-word font change keeps the word whole (bughunt B30)", () => {
  assert.deepEqual(lines([item("W", 72, 700, 20), item("elcome", 92, 700, 70)]), ["Welcome"]);
});

test("a real gap is one space, not two, whether or not pdf.js emitted a space item (bughunt B30)", () => {
  assert.deepEqual(lines([item("Hello", 72, 700, 30), item("World", 182, 700, 30)]), ["Hello World"]);
  assert.deepEqual(lines([item("Hello", 72, 700, 30), item(" ", 102, 700, 3), item("World", 182, 700, 30)]), ["Hello World"]);
});

test("sorting by position puts items on baselines under a point apart in x order, not in the order of the fraction (bughunt B31)", () => {
  const items = [item("aaa", 72, 700, 30), item("bbb", 150, 700.4, 30), item("ccc", 230, 699.7, 30)];
  assert.deepEqual(lines(items, true), ["aaa bbb ccc"]);
});

test("sorting by position still reads top to bottom, and not sorting keeps the stream order", () => {
  const items = [item("Bottom", 72, 600, 40), item("Top", 72, 700, 30)];
  assert.deepEqual(lines(items, true), ["Top", "Bottom"]);
  assert.deepEqual(lines(items, false), ["Bottom", "Top"]);
});
