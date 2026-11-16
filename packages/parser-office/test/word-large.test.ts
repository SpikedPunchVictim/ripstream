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

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

/** A word/document.xml over this size takes the streaming path (LARGE_WORD_DOCUMENT_BYTES in ooxml.ts). */
const OVER_THE_THRESHOLD = 8 * 1024 * 1024 + 1024;

const run = (text: string): string => `<w:r><w:t>${text}</w:t></w:r>`;
const para = (text: string, style?: string): string =>
  `<w:p>${style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}${run(text)}</w:p>`;
const styles =
  `<w:styles ${W}><w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style></w:styles>`;

/** Every construct the two paths must read alike: structure, wrappers, skipped content, text boxes and special characters. */
const BODY = [
  para("Title", "Title"),
  "<w:p/>",
  para("Intro"),
  para("Localized", "berschrift2"),
  `<w:p>${run("a")}<w:r><w:tab/></w:r>${run("b")}<w:r><w:br/></w:r>${run("c")}<w:r><w:noBreakHyphen/></w:r><w:r><w:softHyphen/></w:r><w:r><w:sym w:char="263A"/></w:r><w:r><w:delText>gone</w:delText></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>`,
  `<w:tbl><w:tr><w:tc>${para("r1c1")}<w:p/></w:tc><w:tc>${para("r1c2", "Heading1")}</w:tc></w:tr>` +
    `<w:tr><w:sdt><w:sdtContent><w:tc>${para("r2c1")}</w:tc></w:sdtContent></w:sdt><w:tc><w:tbl><w:tr><w:tc>${para("nested")}</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>`,
  `<w:sdt><w:sdtContent>${para("in a control")}</w:sdtContent></w:sdt>`,
  `<w:ins>${para("inserted")}</w:ins><w:moveFrom>${para("moved away")}</w:moveFrom><w:moveTo>${para("moved here")}</w:moveTo>`,
  `<w:p>${run("with a box")}<mc:AlternateContent><mc:Choice><w:drawing><w:txbxContent>${para("boxed")}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${para("boxed")}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:p>`,
  `<w:p><w:r><w:t><![CDATA[cdata <text>]]></w:t></w:r></w:p>`,
  `<w:sectPr><w:pgSz/></w:sectPr>`,
  para("last"),
].join("");

const FOOTER = `<w:ftr ${W}>${para("foot")}</w:ftr>`;

interface Parsed {
  readonly hints: string[];
  readonly text: string;
}

async function parse(body: string, padding: number, withHints: boolean): Promise<Parsed> {
  // An XML comment adds bytes the parsers ignore, so the same document is read by either path.
  const pad = padding === 0 ? "" : `<!--${"x".repeat(padding)}-->`;
  const raw = strToU8(`<w:document ${W}><w:body>${pad}${body}</w:body></w:document>`);
  assert.equal(raw.byteLength > 8 * 1024 * 1024, padding > 0, "only the padded document is over the threshold");
  const files = {
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": raw,
    "word/styles.xml": strToU8(styles),
    "word/footer1.xml": strToU8(FOOTER),
  };
  const hints: string[] = [];
  const log = {
    layout() {},
    delimited() {},
    line() {},
    shape() {},
    row: (number: number) => hints.push(`row ${number}`),
    col: (number: number) => hints.push(`col ${number}`),
    para: (number: number) => hints.push(`para ${number}`),
    heading: (level: number) => hints.push(`heading ${level}`),
  } satisfies SegmentHints;
  const ctx = new ParseContext();
  if (withHints) ctx.set(CONTEXT_KEYS.SEGMENT_HINTS, log);
  const stream = await RipstreamInputStream.from(zipSync(files));
  const handler = new BodyContentHandler();
  try {
    await new OoxmlParser().parse(stream, handler, new Metadata(), ctx);
  } finally {
    await stream.close();
  }
  return { hints, text: handler.toString() };
}

test("a very large document.xml gives the hints of the normal path: paragraph numbers and headings (tikajs-ne73)", async () => {
  const normal = await parse(BODY, 0, true);
  const large = await parse(BODY, OVER_THE_THRESHOLD, true);
  assert.ok(normal.hints.includes("para 3") && normal.hints.includes("heading 2"), "the fixture gives hints");
  assert.deepEqual(large.hints, normal.hints);
});

test("a very large document.xml has the text of the normal path, with the hints on and off (tikajs-ne73)", async () => {
  const normal = await parse(BODY, 0, true);
  const largeOn = await parse(BODY, OVER_THE_THRESHOLD, true);
  const largeOff = await parse(BODY, OVER_THE_THRESHOLD, false);
  assert.equal(largeOn.text, normal.text);
  assert.equal(largeOff.text, normal.text);
  assert.deepEqual(largeOff.hints, []);
});
