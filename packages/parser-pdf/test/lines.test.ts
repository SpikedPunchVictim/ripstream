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
  assert.deepEqual(lines(items, true), ["Top", "", "Bottom"]);
  assert.deepEqual(lines(items, false), ["Bottom", "Top"]);
});

// tikajs-9y5d: pdf.js puts an empty item with hasEOL at each line end; it is not an empty line. A gap wider than two font
// heights is a paragraph break (Tika's PDFBox writes a blank line), as the Google Docs fixture's table rows show.
test("an empty end-of-line item is not an empty line", () => {
  const empty: PdfTextItem = { str: "", hasEOL: true, transform: [12, 0, 0, 12, 72, 680], height: 0 };
  assert.deepEqual(lines([item("A", 72, 700, 8), empty, item("B", 72, 680, 8)]), ["A", "B"]);
});

test("a gap wider than two font heights is a blank line", () => {
  assert.deepEqual(lines([item("A", 72, 700, 8), item("B", 72, 660, 8)]), ["A", "", "B"]);
});

// tikajs-yt4g: Tika keeps a raised small token on the base line and starts a new line for a lowered one.
test("a superscript stays on its line, sorted by position too", () => {
  const items = [item("E = mc", 72, 700, 45), item("2", 119, 705, 4, 7)];
  assert.deepEqual(lines(items), ["E = mc 2"]);
  assert.deepEqual(lines(items, true), ["E = mc 2"]);
});

test("a subscript starts a line, as Tika does", () => {
  const items = [item("a", 72, 700, 7), item("i", 79, 695, 3, 7), item(" + b", 82, 695, 20, 7)];
  assert.deepEqual(lines(items), ["a", "i + b"]);
  assert.deepEqual(lines(items, true), ["a", "i + b"]);
});
