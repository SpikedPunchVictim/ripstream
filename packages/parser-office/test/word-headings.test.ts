import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CONTEXT_KEYS,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type SegmentHints,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { OoxmlParser } from "../src/index.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const style = (id: string, name: string): string => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`;
const paragraph = (id: string | undefined, text: string): string =>
  `<w:p>${id === undefined ? "" : `<w:pPr><w:pStyle w:val="${id}"/></w:pPr>`}<w:r><w:t>${text}</w:t></w:r></w:p>`;

/** The heading levels the parser says, in order; and the text written. */
async function headings(body: string, styles: string | undefined, withHints = true): Promise<{ levels: string[]; text: string }> {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
  };
  if (styles !== undefined) files["word/styles.xml"] = strToU8(`<w:styles ${W}>${styles}</w:styles>`);
  const levels: string[] = [];
  const hints = {
    layout() {},
    delimited() {},
    line() {},
    row() {},
    col() {},
    shape() {},
    heading: (level: number) => levels.push(`${level}`),
  } satisfies SegmentHints;
  const ctx = new ParseContext();
  if (withHints) ctx.set(CONTEXT_KEYS.SEGMENT_HINTS, hints);
  const stream = await RipstreamInputStream.from(zipSync(files));
  const handler = new BodyContentHandler();
  try {
    await new OoxmlParser().parse(stream, handler, new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  return { levels, text: handler.toString() };
}

test("a paragraph style whose id is localized is a heading by the name styles.xml gives it (tikajs-bwjq)", async () => {
  const styles = style("berschrift1", "heading 1") + style("Titre2", "heading 2") + style("Titel", "Title") + style("Body", "Normal");
  const body = paragraph("berschrift1", "One") + paragraph("Titre2", "Two") + paragraph("Titel", "Doc") + paragraph("Body", "Plain");
  const { levels } = await headings(body, styles);
  assert.deepEqual(levels, ["1", "2", "1"]);
});

test("the ids Heading1 and Title are headings with no styles.xml, as before", async () => {
  const { levels } = await headings(paragraph("Heading3", "Three") + paragraph("Title", "Doc") + paragraph(undefined, "Plain"), undefined);
  assert.deepEqual(levels, ["3", "1"]);
});

test("a style that is not named heading N is not a heading, and the text is the same with the hints off", async () => {
  const styles = style("Kopf", "header") + style("Eigen", "my heading 1");
  const body = paragraph("Kopf", "A") + paragraph("Eigen", "B");
  const on = await headings(body, styles);
  const off = await headings(body, styles, false);
  assert.deepEqual(on.levels, []);
  assert.equal(on.text, off.text);
});
