import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { PdfParser } from "../src/index.ts";
import { createGapBuffers, respaced, type GapInput } from "../src/pdf-glyph-gaps.ts";
import { lines, type PdfTextItem } from "../src/pdf-lines.ts";
import { classicPdf, onePageObjects, streamObject } from "./fixtures.ts";

// Oracle (Tika 4.2.0 /rmeta/text, Helvetica 11 pt, one glyph to a run): digits a gap of 0.12 em apart read '1234', 0.20 em
// apart '1 2 3 4'; two narrow letters 0.08 em apart are separated, and 0.04 em apart are not (tikajs-4c5k).
const OPS: Record<string, number> = {
  save: 1, restore: 2, transform: 3, beginText: 4, setCharSpacing: 5, setWordSpacing: 6, setHScale: 7, setLeading: 8, setFont: 9,
  setTextRise: 10, moveText: 11, setLeadingMoveText: 12, setTextMatrix: 13, nextLine: 14, showText: 15, showSpacedText: 16,
  paintFormXObjectBegin: 17, paintFormXObjectEnd: 18,
};
type Op = [string, unknown[]];
const glyph = (unicode: string, width = 556, isSpace = false): object => ({ unicode, width, isSpace });
const input = (operators: Op[], font: GapInput["font"] = () => ({ name: "Helvetica" })): GapInput => ({
  list: { fnArray: operators.map(([name]) => OPS[name]!), argsArray: operators.map(([, args]) => args) },
  ops: OPS,
  font,
});
/** Digits at 11 pt, each shown on its own, `gap` em after the one before. */
function digits(text: string, gap: number): Op[] {
  const result: Op[] = [["beginText", []], ["setFont", ["F1", 11]]];
  let x = 20;
  for (const ch of text) {
    result.push(["setTextMatrix", [1, 0, 0, 1, x, 0]], ["showText", [[glyph(ch)]]]);
    x += (556 * 11) / 1000 + gap * 11;
  }
  return result;
}
const item = (str: string, extra: Partial<PdfTextItem> = {}): PdfTextItem => ({ str, transform: [11, 0, 0, 11, 20, 700], width: 50, height: 11, ...extra });
const strings = (items: PdfTextItem[] | null): string[] | null => items?.map((i) => i.str ?? "") ?? null;

test("a gap under PDFBox's threshold takes the space pdf.js put in; one over it gets the space pdf.js left out", () => {
  assert.deepEqual(strings(respaced([item("1 2 3 4")], input(digits("1234", 0.12)))), ["1234"]);
  assert.deepEqual(strings(respaced([item("1234")], input(digits("1234", 0.2)))), ["1 2 3 4"]);
  assert.deepEqual(strings(respaced([item("1 2 3 4")], input(digits("1234", 0.2)))), ["1 2 3 4"]);
});

test("the threshold is that of the font's space: Times' is lower than Helvetica's", () => {
  const times = () => ({ name: "Times-Roman" });
  // 0.13 em: over Times' 0.125 (a space of 250), under Helvetica's 0.139 (a space of 278).
  assert.deepEqual(strings(respaced([item("1234")], input(digits("1234", 0.13), times))), ["1 2 3 4"]);
  assert.deepEqual(strings(respaced([item("1234")], input(digits("1234", 0.13)))), ["1234"]);
});

test("narrow glyphs are parted by a smaller gap than wide ones", () => {
  const narrow = (gap: number): Op[] => {
    const result: Op[] = [["beginText", []], ["setFont", ["F1", 11]]];
    let x = 20;
    for (const ch of "il") {
      result.push(["setTextMatrix", [1, 0, 0, 1, x, 0]], ["showText", [[glyph(ch, 222)]]]);
      x += (222 * 11) / 1000 + gap * 11;
    }
    return result;
  };
  assert.deepEqual(strings(respaced([item("il")], input(narrow(0.08)))), ["i l"]);
  assert.deepEqual(strings(respaced([item("i l")], input(narrow(0.04)))), ["il"]);
});

test("whitespace beside a space glyph is left as pdf.js has it", () => {
  const operators: Op[] = [["beginText", []], ["setFont", ["F1", 11]], ["moveText", [20, 0]], ["showText", [[glyph("a"), glyph(" ", 278, true), glyph("b")]]]];
  assert.deepEqual(strings(respaced([item("a b")], input(operators))), ["a b"]);
  assert.deepEqual(strings(respaced([item("a  b")], input(operators))), ["a  b"]);
});

test("a TJ kerning number is part of the gap", () => {
  const operators: Op[] = [["beginText", []], ["setFont", ["F1", 11]], ["moveText", [20, 0]], ["showSpacedText", [[glyph("1"), -120, glyph("2"), -200, glyph("3")]]]];
  assert.deepEqual(strings(respaced([item("1 2 3")], input(operators))), ["12 3"]);
});

test("items that do not line up with the glyphs are left alone (null), whatever the reason", () => {
  assert.equal(respaced([item("1 2 9 4")], input(digits("1234", 0.12))), null);
  assert.equal(respaced([item("1 2 3 4 5")], input(digits("1234", 0.12))), null);
  assert.equal(respaced([item("1 2", { dir: "rtl" })], input(digits("12", 0.12))), null);
  assert.equal(respaced([item("1 2")], input([])), null);
});

test("a format character is no glyph, a combining mark has no width, and any whitespace character is a glyph pdf.js writes no item for", () => {
  const between = (middle: object): Op[] => [["beginText", []], ["setFont", ["F1", 11]], ["moveText", [20, 0]], ["showText", [[glyph("1"), middle, glyph("2")]]]];
  // U+00AD takes no room and has no item: the 2 follows the 1 directly.
  assert.deepEqual(strings(respaced([item("1 2")], input(between(glyph("\u00ad"))))), ["12"]);
  // U+0301 is in the item and at the end of the 1 (its advance is nothing): the 2 follows it directly.
  assert.deepEqual(strings(respaced([item("1\u0301 2")], input(between(glyph("\u0301"))))), ["1\u03012"]);
  for (const space of ["\u00a0", "\t", "\u2003"]) {
    for (const text of ["1 2", "12"]) assert.deepEqual(strings(respaced([item(text)], input(between(glyph(space, 278))))), [text], JSON.stringify(space));
  }
});

test("the glyph columns kept between pages leave nothing of a longer page for a shorter one", () => {
  const buffers = createGapBuffers();
  const pages: Array<[string, number]> = [["123456789", 0.12], ["12", 0.2], ["1234", 0.12], ["12345678901234567890", 0.2], ["1234", 0.2]];
  for (const [text, gap] of pages) {
    const operators = digits(text, gap);
    const fresh = respaced([item(text.split("").join(" "))], input(operators));
    assert.deepEqual(respaced([item(text.split("").join(" "))], { ...input(operators), buffers }), fresh);
  }
  assert.deepEqual(strings(respaced([item("1234")], { ...input(digits("1234", 0.2)), buffers })), ["1 2 3 4"]);
});

test("vertical fonts and unknown fonts are not read", () => {
  assert.equal(respaced([item("1 2")], input(digits("12", 0.12), () => ({ vertical: true }))), null);
  assert.equal(respaced([item("1 2")], input(digits("12", 0.12), () => undefined)), null);
});

test("text outside the page's box has no item and is skipped", () => {
  const operators: Op[] = [["beginText", []], ["setFont", ["F1", 11]], ["moveText", [-500, 0]], ["showText", [[glyph("x")]]], ["moveText", [520, 0]], ["showText", [[glyph("1")]]]];
  assert.deepEqual(strings(respaced([item("1")], { ...input(operators), view: [0, 0, 600, 800] })), ["1"]);
});

test("between two items, pdf.js's whitespace item goes where PDFBox has no separator, and one is left where it has", () => {
  const operators = (gap: number): Op[] => {
    const x = 20 + (4 * 556 * 11) / 1000 + gap * 11;
    return [["beginText", []], ["setFont", ["F1", 11]], ["moveText", [20, 0]], ["showText", [[glyph("1"), glyph("2"), glyph("3"), glyph("4")]]], ["moveText", [x - 20, 0]], ["showText", [[glyph("5"), glyph("6")]]]];
  };
  const parts = [item("1234"), item(" ", { height: 0 }), item("56", { transform: [11, 0, 0, 11, 66, 700] })];
  assert.deepEqual(strings(respaced(parts, input(operators(0.12)))), ["1234", "56"]);
  assert.deepEqual(strings(respaced(parts, input(operators(0.2)))), ["1234", " ", "56"]);
});

test("an item PDFBox joins to the one before is written without lines()'s space, and one it parts from with it", () => {
  const pair = (width: number, gap: number): [Op[], PdfTextItem[]] => {
    const x = 20 + (4 * width * 11) / 1000 + gap * 11;
    const operators: Op[] = [["beginText", []], ["setFont", ["F1", 11]], ["moveText", [20, 0]], ["showText", [[..."1234"].map((ch) => glyph(ch, width))]], ["moveText", [x - 20, 0]], ["showText", [[glyph("5", width), glyph("6", width)]]]];
    return [operators, [item("1234", { width: (4 * width * 11) / 1000 }), item("56", { transform: [11, 0, 0, 11, x, 700] })]];
  };
  // Helvetica digits 0.145 em apart: PDFBox's threshold is 0.139, lines()'s own 0.15.
  const [near, nearItems] = pair(556, 0.145);
  assert.deepEqual(lines(nearItems), ["123456"]);
  assert.deepEqual(lines(respaced(nearItems, input(near))!), ["1234 56"]);
  // Courier 0.16 em apart: PDFBox's threshold is 0.18.
  const [wide, wideItems] = pair(600, 0.16);
  assert.deepEqual(lines(wideItems), ["1234 56"]);
  assert.deepEqual(lines(respaced(wideItems, input(wide, () => ({ name: "Courier" })))!), ["123456"]);
});

test("a glyph on another line has no separator decided, and the item is as pdf.js has it", () => {
  const operators: Op[] = [["beginText", []], ["setFont", ["F1", 11]], ["moveText", [20, 0]], ["showText", [[glyph("1")]]], ["moveText", [10, -30]], ["showText", [[glyph("2")]]]];
  assert.deepEqual(strings(respaced([item("1 2")], input(operators))), ["1 2"]);
});

test("a page with more operators than the limit is read, with the spacing pdf.js gave it (tikajs-4c5k)", async () => {
  // 220,000 path operators in front of the text: pdf.js would hold them all, so the read of the operator list is cut off.
  const objects = onePageObjects("Hello world");
  objects[3] = streamObject(`${"1 1 m 2 2 l S\n".repeat(110_000)}BT /F1 24 Tf 72 700 Td (Hello world) Tj ET`);
  const stream = await RipstreamInputStream.from(Buffer.from(classicPdf(objects), "latin1"));
  const handler = new BodyContentHandler();
  try {
    await new PdfParser().parse(stream, handler, new Metadata(), new ParseContext());
  } finally {
    await stream.close();
  }
  assert.match(handler.toString(), /Hello world/);
});
