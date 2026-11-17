import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { createRipstream } from "../src/index.ts";

/*
 * tikajs-9zu2: a docx paragraph style is written as the heading Tika writes. The expected tags below are what Tika 4.2.0
 * (XWPFEventBasedWordExtractor, /rmeta/html) wrote for the same package, read from its answer, not from its source. Where
 * ripstream writes less than Tika it is said at the test.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const ripstream = createRipstream();

const style = (id: string, name: string): string => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`;
const paragraph = (id: string | undefined, text: string): string =>
  `<w:p>${id === undefined ? "" : `<w:pPr><w:pStyle w:val="${id}"/></w:pPr>`}<w:r><w:t>${text}</w:t></w:r></w:p>`;

/** A docx whose styles.xml has `styles` (none: the part is absent) and whose body is `body`. */
function docx(body: string, styles: string | undefined): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
  };
  if (styles !== undefined) files["word/styles.xml"] = strToU8(`<w:styles ${W}>${styles}</w:styles>`);
  return zipSync(files);
}

async function bodyHtml(bytes: Uint8Array): Promise<string[]> {
  const { text } = await ripstream.parse(bytes, { filename: "a.docx", handlerType: "html" });
  return /<body>([\s\S]*)<\/body>/.exec(text)![1]!.trim().split("\n");
}

const NAMES: ReadonlyArray<readonly [string, string, string]> = [
  // id, style name, what Tika writes for a paragraph "T-<id>"
  ["Title", "Title", '<h1 class="title">'],
  ["Subtitle", "Subtitle", '<h2 class="subtitle">'],
  ["Heading1", "heading 1", "<h1>"],
  ["Heading2", "heading 2", "<h2>"],
  ["Heading3", "heading 3", "<h3>"],
  ["Heading6", "heading 6", "<h6>"],
  ["Heading7", "heading 7", "<h6>"],
  ["Heading9", "heading 9", "<h6>"],
];

test("Title, Subtitle and heading 1-9 are the headings Tika writes, h1-h6 with Title and Subtitle's classes", async () => {
  const body = NAMES.map(([id]) => paragraph(id, `T-${id}`)).join("");
  const lines = await bodyHtml(docx(body, NAMES.map(([id, name]) => style(id, name)).join("")));
  assert.deepEqual(
    lines,
    NAMES.map(([id, , open]) => `${open}T-${id}</${open.slice(1, 3)}>`),
  );
});

test("the tag comes from the style's name in styles.xml, not its id: localized ids, a name that is not a heading", async () => {
  const styles = style("berschrift1", "heading 1") + style("Titel", "Title") + style("Heading1", "Kop 1") + style("Foo", "Heading 1");
  const body = paragraph("berschrift1", "A") + paragraph("Titel", "B") + paragraph("Heading1", "C") + paragraph("Foo", "D");
  // Tika: <h1>A</h1> <h1 class="title">B</h1> <p class="kop_1">C</p> <h1>D</h1>; the class of a plain paragraph is not written.
  assert.deepEqual(await bodyHtml(docx(body, styles)), ["<h1>A</h1>", '<h1 class="title">B</h1>', "<p>C</p>", "<h1>D</h1>"]);
});

test("a name is a heading by Tika's rule: it starts with heading or Heading and ends in the digit, 1 when there is none", async () => {
  const names = ["heading1", "Heading", "heading x", "Heading 12", "heading  2", "Heading 1 Char", "HEADING 1", "title", "Title ", "subtitle"];
  const styles = names.map((name, index) => style(`S${index}`, name)).join("");
  const body = names.map((name, index) => paragraph(`S${index}`, name)).join("");
  // Tika wrote h1, h1, h1, h2, h2, h1, then p (HEADING 1), p (title), p (Title with a space), p (subtitle).
  assert.deepEqual(await bodyHtml(docx(body, styles)), [
    "<h1>heading1</h1>",
    "<h1>Heading</h1>",
    "<h1>heading x</h1>",
    "<h2>Heading 12</h2>",
    "<h2>heading  2</h2>",
    "<h1>Heading 1 Char</h1>",
    "<p>HEADING 1</p>",
    "<p>title</p>",
    "<p>Title </p>",
    "<p>subtitle</p>",
  ]);
});

test("heading 0 is h1: Tika's h0 is not an element", async () => {
  assert.deepEqual(await bodyHtml(docx(paragraph("Z", "A"), style("Z", "heading 0"))), ["<h1>A</h1>"]);
});

test("without styles.xml, or with no name for the id, a paragraph is plain, as in Tika", async () => {
  assert.deepEqual(await bodyHtml(docx(paragraph("Heading1", "A") + paragraph("Title", "B"), undefined)), ["<p>A</p>", "<p>B</p>"]);
  assert.deepEqual(await bodyHtml(docx(paragraph("Heading1", "A") + paragraph("Zzz", "B"), style("Other", "heading 2"))), ["<p>A</p>", "<p>B</p>"]);
});

test("a heading in a table cell is a plain paragraph, as Tika writes no tags in a cell", async () => {
  const body = `<w:tbl><w:tr><w:tc>${paragraph("Heading1", "InCell")}</w:tc></w:tr></w:tbl>${paragraph("Heading1", "After")}`;
  const lines = (await bodyHtml(docx(body, style("Heading1", "heading 1")))).join("\n");
  assert.match(lines, /<td><p>InCell<\/p>/);
  assert.match(lines, /<h1>After<\/h1>/);
});

test("markdown writes # marks for the headings", async () => {
  const bytes = docx(paragraph("Title", "Doc") + paragraph("Heading1", "One") + paragraph("Heading2", "Two") + paragraph(undefined, "body"), style("Title", "Title") + style("Heading1", "heading 1") + style("Heading2", "heading 2"));
  const { text } = await ripstream.parse(bytes, { filename: "a.docx", handlerType: "markdown" });
  assert.equal(text, "# Doc\n\n# One\n\n## Two\n\nbody\n");
});

test("the text is the same with or without heading styles", async () => {
  const body = paragraph("Title", "Doc") + paragraph("Heading1", "One") + paragraph(undefined, "body");
  const styled = await ripstream.parse(docx(body, style("Title", "Title") + style("Heading1", "heading 1")), { filename: "a.docx" });
  const plain = await ripstream.parse(docx(body, undefined), { filename: "a.docx" });
  assert.equal(styled.text, "Doc\nOne\nbody\n");
  assert.equal(styled.text, plain.text);
});

test("an unreadable styles.xml is no styles: no heading tags, and the same text", async () => {
  const bytes = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(`<w:document ${W}><w:body>${paragraph("Heading1", "One")}</w:body></w:document>`),
    "word/styles.xml": strToU8("<w:styles><w:style"),
  });
  assert.deepEqual(await bodyHtml(bytes), ["<p>One</p>"]);
  assert.equal((await ripstream.parse(bytes, { filename: "a.docx" })).text, "One\n");
});

test("Title is a level-1 heading in the segments' chain, as Tika writes it h1; Subtitle is level 2", async () => {
  const styles = style("Title", "Title") + style("Subtitle", "Subtitle") + style("Heading1", "heading 1") + style("Heading2", "heading 2");
  const body = paragraph("Title", "Doc") + paragraph("Subtitle", "Sub") + paragraph(undefined, "intro") + paragraph("Heading1", "One") + paragraph(undefined, "text");
  const [record] = await ripstream.parseRecursive(docx(body, styles), { filename: "a.docx", segments: true });
  const found = record!.segments!.filter((segment) => segment.location.startsWith("para=")).map((segment) => [segment.text, segment.labels.join(" > ")]);
  assert.deepEqual(found, [
    ["Doc", ""],
    ["Sub", "Doc"],
    ["intro", "Doc > Sub"],
    // A level-1 heading replaces the level-1 Title in the chain, and takes the chain before it as its own labels.
    ["One", "Doc > Sub"],
    ["text", "One"],
  ]);
});
