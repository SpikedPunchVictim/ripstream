import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  leafSegments,
  MediaType,
  Metadata,
  parseSegmentLocation,
  Ripstream,
  RipstreamInputStream,
  XHTMLContentHandler,
  type ContentHandler,
  type Detector,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type ParseOptions,
  type ParseRecord,
  type Parser,
  type Segment,
  type SegmentHints,
} from "../src/index.ts";
import { createOutputHandler } from "../src/handler-type.ts";
import { SegmentTap } from "../src/segments.ts";

/** A fake parser: the document's name picks a script, which writes XHTML (and hints) the way a real parser would. */
type Script = (xhtml: XHTMLContentHandler, hints: SegmentHints | undefined, ctx: ParseContext, handler: ContentHandler) => Promise<void>;

const SCRIPTS: Record<string, { readonly type: MediaType; readonly script: Script }> = {};
let seenHints: (SegmentHints | undefined)[] = [];

function script(name: string, type: string, body: Script): string {
  SCRIPTS[name] = { type: MediaType.parse(type)!, script: body };
  return name;
}

const nameOf = (metadata: Metadata): string => metadata.get("tk:resource-name") ?? "";

const detector: Detector = {
  detect: async (_stream, metadata) => SCRIPTS[nameOf(metadata)]?.type ?? MediaType.OCTET_STREAM,
};

const scripted: Parser = {
  name: "Scripted",
  getSupportedTypes: () => new Set(Object.values(SCRIPTS).map((entry) => entry.type)),
  async parse(stream, handler, metadata, ctx): Promise<void> {
    for await (const _chunk of stream) { /* read it all */ }
    const name = nameOf(metadata);
    const hints = ctx.get(CONTEXT_KEYS.SEGMENT_HINTS);
    seenHints.push(hints);
    // As a real parser does: the segments read the dialect (html, tsv, json) from it.
    metadata.set("Content-Type", SCRIPTS[name]!.type.toString());
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await SCRIPTS[name]!.script(xhtml, hints, ctx, handler);
    await xhtml.endDocument();
  },
};

const ripstream = new Ripstream({ detector, parser: scripted });

const BYTES = new Uint8Array([1]);

function parse(name: string, options: ParseOptions = {}): Promise<readonly ParseRecord[]> {
  return ripstream.parseRecursive(BYTES, { filename: name, ...options });
}

function segmentsOf(name: string, options: ParseOptions = {}): Promise<readonly ParseRecord[]> {
  return parse(name, { segments: true, ...options });
}

function lines(segments: readonly Segment[] | undefined): string[] {
  return (segments ?? []).map((segment) => `${segment.location} | ${segment.text} | ${segment.labels.join(" > ")}`);
}

const DOCUMENT = script("document", "application/x-document", async (xhtml) => {
  await xhtml.element("h1", "Customers");
  await xhtml.element("p", "Intro.");
  await xhtml.element("h2", "Banking");
  await xhtml.element("p", "Holder PLANTED-P.");
  await xhtml.startElement("table");
  for (const row of [["Name", "IBAN"], ["Ann", "NL01"], ["Bob", "PLANTED-CELL"]]) {
    await xhtml.startElement("tr");
    for (const cell of row) await xhtml.element("td", cell);
    await xhtml.endElement("tr");
  }
  await xhtml.endElement("table");
  await xhtml.startElement("div", "class", "footer");
  await xhtml.element("p", "Page footer");
  await xhtml.endElement("div");
});

test("parseSegmentLocation reads the keys in order and decodes the values", () => {
  assert.deepEqual([...parseSegmentLocation("sheet=A%3BB%3Dc%25;cell=C7")], [["sheet", "A;B=c%"], ["cell", "C7"]]);
  assert.deepEqual([...parseSegmentLocation("slide=3;part=notes;shape=Title 2")], [
    ["slide", "3"],
    ["part", "notes"],
    ["shape", "Title 2"],
  ]);
});

test("parseSegmentLocation refuses keys out of order, twice, unknown, or without a value", () => {
  for (const bad of ["cell=C7;sheet=A", "row=1;row=2", "colour=red", "row", "", "=1"]) {
    assert.throws(() => parseSegmentLocation(bad), RangeError, bad);
  }
});

function segment(start: number, end: number, location: string, content: string): Segment {
  return { text: content.slice(start, end), start, end, labels: [], location };
}

test("leafSegments drops a row and a shape made of the cells in them, and keeps the cells", () => {
  const content = "Name\tTax id\nAcme\tPLANTED-1";
  const segments = [
    segment(0, 11, "slide=1;shape=Table 1", content),
    segment(0, 11, "row=1", content),
    segment(0, 4, "row=1;col=1", content),
    segment(5, 11, "row=1;col=2", content),
  ];
  assert.deepEqual(leafSegments([...segments]).map((s) => s.location), ["row=1;col=1", "row=1;col=2"]);
});

test("leafSegments keeps a segment with text its parts do not hold", () => {
  const content = "item one\n  nested";
  const outer = segment(0, 17, "selector=body > ul > li", content);
  const inner = segment(11, 17, "selector=body > ul > li > ul > li", content);
  assert.deepEqual(leafSegments([outer, inner]).map((s) => s.location), [outer.location, inner.location]);
});

test("leafSegments keeps a lone row of one cell as that cell, and a list with no overlap whole", () => {
  const content = "a\nb";
  const row = segment(0, 1, "row=1", content);
  const cell = segment(0, 1, "row=1;col=1", content);
  const other = segment(2, 3, "row=2", content);
  assert.deepEqual(leafSegments([row, cell, other]).map((s) => s.location), ["row=1;col=1", "row=2"]);
  assert.deepEqual(leafSegments([]), []);
});

test("segments are off by default: no segments on the records and no hints for the parsers", async () => {
  seenHints = [];
  const records = await parse(DOCUMENT);
  assert.equal(records[0]!.segments, undefined);
  assert.deepEqual(seenHints, [undefined]);
});

test("segments need a boolean and a handlerType of text or body", async () => {
  await assert.rejects(parse(DOCUMENT, { segments: "yes" as unknown as boolean }), TypeError);
  for (const handlerType of ["xml", "html", "ignore"] as const) {
    await assert.rejects(segmentsOf(DOCUMENT, { handlerType }), RangeError, handlerType);
  }
  await assert.doesNotReject(segmentsOf(DOCUMENT, { handlerType: "body" }));
});

test("a document's blocks are numbered paragraphs under their headings; a table gives rows and labelled cells", async () => {
  const [record] = await segmentsOf(DOCUMENT);
  assert.deepEqual(lines(record!.segments), [
    "para=1 | Customers | ",
    "para=2 | Intro. | Customers",
    "para=3 | Banking | Customers",
    "para=4 | Holder PLANTED-P. | Customers > Banking",
    "table=1;row=1 | Name\tIBAN | Customers > Banking",
    "table=1;row=1;col=1 | Name | Customers > Banking",
    "table=1;row=1;col=2 | IBAN | Customers > Banking",
    "table=1;row=2 | Ann\tNL01 | Customers > Banking",
    "table=1;row=2;col=1 | Ann | Customers > Banking > Name",
    "table=1;row=2;col=2 | NL01 | Customers > Banking > IBAN",
    "table=1;row=3 | Bob\tPLANTED-CELL | Customers > Banking",
    "table=1;row=3;col=1 | Bob | Customers > Banking > Name",
    "table=1;row=3;col=2 | PLANTED-CELL | Customers > Banking > IBAN",
    "part=footer;para=5 | Page footer | ",
  ]);
});

test("each segment's text is its slice of the content, and the content is the same with segments off", async () => {
  for (const handlerType of ["text", "body"] as const) {
    const [on] = await segmentsOf(DOCUMENT, { handlerType });
    const [off] = await parse(DOCUMENT, { handlerType });
    assert.equal(on!.content, off!.content, handlerType);
    for (const segment of on!.segments!) assert.equal(on!.content.slice(segment.start, segment.end), segment.text);
    assert.ok(Object.isFrozen(on!.segments![0]));
  }
});

const SHEET = script("sheet", "application/x-sheet", async (xhtml, hints) => {
  await xhtml.startElement("div", "class", "sheet");
  await xhtml.element("h1", "Vendors;Q=1");
  await xhtml.startElement("table");
  for (const [number, row] of [[1, ["Name", "Tax ID"]], [7, ["Ann", "PLANTED-C7"]]] as const) {
    hints?.row(number);
    await xhtml.startElement("tr");
    for (const cell of row) await xhtml.element("td", cell);
    await xhtml.endElement("tr");
  }
  await xhtml.endElement("table");
  await xhtml.endElement("div");
});

test("a row hint gives a sheet's cells their A1 reference; the sheet is named by its heading, escaped", async () => {
  const [record] = await segmentsOf(SHEET);
  const cell = record!.segments!.find((segment) => segment.text === "PLANTED-C7")!;
  assert.equal(cell.location, "sheet=Vendors%3BQ%3D1;cell=B7");
  assert.deepEqual(cell.labels, ["Vendors;Q=1", "Tax ID"]);
  assert.equal(parseSegmentLocation(cell.location).get("sheet"), "Vendors;Q=1");
  assert.ok(lines(record!.segments).includes("sheet=Vendors%3BQ%3D1;row=7 | Ann\tPLANTED-C7 | Vendors;Q=1"));
});

const SLIDES = script("slides", "application/x-slides", async (xhtml, hints) => {
  for (const [title, body] of [["Intro", "Hello"], ["Secrets", "PLANTED-BODY"]]) {
    await xhtml.startElement("div", "class", "slide");
    hints?.shape("Title 1", true);
    await xhtml.element("p", title);
    hints?.shape("Content 2");
    await xhtml.element("p", body);
    await xhtml.endElement("div");
  }
  await xhtml.startElement("div", "class", "notes");
  hints?.shape("Notes 3");
  await xhtml.element("p", "PLANTED-NOTES");
  await xhtml.endElement("div");
});

test("shape hints locate a slide's text by shape; the title shape labels the slide, its notes too", async () => {
  const [record] = await segmentsOf(SLIDES);
  assert.deepEqual(lines(record!.segments), [
    "slide=1;shape=Title 1 | Intro | ",
    "slide=1;shape=Content 2 | Hello | Intro",
    "slide=2;shape=Title 1 | Secrets | ",
    "slide=2;shape=Content 2 | PLANTED-BODY | Secrets",
    "slide=2;part=notes;shape=Notes 3 | PLANTED-NOTES | Secrets",
  ]);
});

const MARKDOWN = script("markdown", "text/markdown", async (xhtml, hints) => {
  for (const [line, heading, text] of [[1, 1, "Title"], [3, 0, "Body PLANTED-MD"]] as const) {
    hints?.line(line);
    if (heading > 0) hints?.heading(heading);
    await xhtml.element("p", text);
  }
});

test("line and heading hints locate a block by source line and make it a heading", async () => {
  const [record] = await segmentsOf(MARKDOWN);
  assert.deepEqual(lines(record!.segments), ["line=1 | Title | ", "line=3 | Body PLANTED-MD | Title"]);
});

/** As TextParser writes text: a p per line, the layout declared first. */
function textLines(name: string, type: string, text: string): string {
  return script(name, type, async (xhtml, hints) => {
    hints?.layout("lines");
    for (const line of text.split("\n")) {
      await xhtml.startElement("p");
      if (line.length > 0) await xhtml.characters(line);
      await xhtml.endElement("p");
    }
  });
}

test("text lines are numbered; tsv lines are rows of tab-separated cells labelled by the first line", async () => {
  const [plain] = await segmentsOf(textLines("plain", "text/plain", "one\ntwo PLANTED"));
  assert.deepEqual(lines(plain!.segments), ["line=1 | one | ", "line=2 | two PLANTED | "]);
  const [tsv] = await segmentsOf(textLines("tsv", "text/tab-separated-values", "a\tb\nx\tPLANTED"));
  assert.deepEqual(lines(tsv!.segments), [
    "row=1 | a\tb | ",
    "row=1;col=1 | a | ",
    "row=1;col=2 | b | ",
    "row=2 | x\tPLANTED | ",
    "row=2;col=1 | x | a",
    "row=2;col=2 | PLANTED | b",
  ]);
});

test("json text gives a segment per scalar, by JSON Pointer; text that is not JSON falls back to lines", async () => {
  const json = '{"a":[{"b~/":"PLANTED"}],"n":1}';
  const [record] = await segmentsOf(textLines("json", "application/json", json));
  assert.deepEqual(lines(record!.segments), ["ptr=/a/0/b~0~1 | PLANTED | a > b~/", "ptr=/n | 1 | n"]);
  const [broken] = await segmentsOf(textLines("broken-json", "application/json", '{"a": [1,\n2'));
  assert.deepEqual(lines(broken!.segments), ['line=1 | {"a": [1, | ', "line=2 | 2 | "]);
});

test("json whose locations would outgrow the allowance gets line segments and a flag, not a gigabyte of pointers (tikajs-yub3)", async () => {
  // One 2,000-character key above 20,000 scalars: a pointer of 2,000 characters each, 40 million in all (the allowance at the
  // default maxOutputChars is about 25 million). 98 KB of this took over 1 GB when every pointer was built.
  const json = `{"${"k".repeat(2000)}":[${Array(20_000).fill("1").join(",")}]}`;
  const [record] = await segmentsOf(textLines("huge-key-json", "application/json", json));
  const segments = record!.segments!;
  assert.deepEqual(segments.map((segment) => segment.location), ["line=1"]);
  assert.equal(segments[0]!.text, json.slice(0, record!.content.length).trim());
  assert.equal(record!.metadata.get("tk:segments-degraded"), "ptr");
  const [small] = await segmentsOf(textLines("small-json", "application/json", '{"a":[1,2]}'));
  assert.deepEqual(lines(small!.segments), ["ptr=/a/0 | 1 | a", "ptr=/a/1 | 2 | a"]);
  assert.equal(small!.metadata.get("tk:segments-degraded"), null);
});

test("html whose selectors would outgrow the allowance is located by paragraph and flagged (tikajs-yub3)", async () => {
  const metadata = new Metadata();
  metadata.set("Content-Type", "text/html");
  const content = createOutputHandler("text");
  const tap = new SegmentTap(content, metadata, { locationAllowance: 400 });
  const xhtml = new XHTMLContentHandler(tap, metadata);
  await xhtml.startDocument();
  for (let depth = 0; depth < 40; depth++) await xhtml.startElement("div");
  await xhtml.element("p", "deep one");
  await xhtml.element("p", "deep two");
  for (let depth = 0; depth < 40; depth++) await xhtml.endElement("div");
  await xhtml.endDocument();
  const found = tap.finish(content.toString());
  assert.deepEqual(found.map((segment) => segment.location), ["para=1", "para=2"]);
  assert.equal(metadata.get("tk:segments-degraded"), "selector");
});

test("delimited lines whose cell locations would outgrow the allowance are line segments and flagged (tikajs-e0sm)", async () => {
  const metadata = new Metadata();
  const content = createOutputHandler("text");
  const tap = new SegmentTap(content, metadata, { locationAllowance: 30 });
  tap.layout("lines");
  tap.delimited(",");
  const xhtml = new XHTMLContentHandler(tap, metadata);
  await xhtml.startDocument();
  for (const line of ["a,b", "1,2", "3,4"]) await xhtml.element("p", line);
  await xhtml.endDocument();
  const found = tap.finish(content.toString());
  assert.deepEqual(found.map((segment) => segment.location), ["line=1", "line=2", "line=3"]);
  assert.equal(metadata.get("tk:segments-degraded"), "cell");
});

test("delimited ignores a delimiter that is a quote or a line break (tikajs-e0sm)", async () => {
  const metadata = new Metadata();
  const content = createOutputHandler("text");
  const tap = new SegmentTap(content, metadata);
  tap.layout("lines");
  tap.delimited('"');
  tap.delimited("ab");
  const xhtml = new XHTMLContentHandler(tap, metadata);
  await xhtml.startDocument();
  await xhtml.element("p", "a,b");
  await xhtml.endDocument();
  assert.deepEqual(tap.finish(content.toString()).map((segment) => segment.location), ["line=1"]);
});

test("two shapes of a slide with the same name are located apart; the next slide starts again (tikajs-57wb)", async () => {
  const slides = script("same-shape-names", "application/x-slides", async (xhtml, hints) => {
    for (let slide = 0; slide < 2; slide++) {
      await xhtml.startElement("div", "class", "slide");
      for (const [shape, text] of [["TextBox 1", "first"], ["TextBox 1", "second"], ["Other", "third"]] as const) {
        hints?.shape(shape);
        await xhtml.element("p", text);
      }
      hints?.shape(undefined);
      await xhtml.endElement("div");
    }
  });
  const [record] = await segmentsOf(slides);
  const locations = record!.segments!.map((segment) => segment.location);
  assert.deepEqual(locations, [
    "slide=1;shape=TextBox 1",
    "slide=1;shape=TextBox 1~2",
    "slide=1;shape=Other",
    "slide=2;shape=TextBox 1",
    "slide=2;shape=TextBox 1~2",
    "slide=2;shape=Other",
  ]);
});

test("html is located by selector: nth-of-type from the body, an id where there is one", async () => {
  const html = script("html", "text/html", async (xhtml) => {
    await xhtml.element("p", "first");
    await xhtml.startElement("div", "id", "box");
    await xhtml.element("p", "PLANTED-HTML");
    await xhtml.endElement("div");
  });
  const [record] = await segmentsOf(html);
  assert.deepEqual(lines(record!.segments), ["selector=body > p:nth-of-type(1) | first | ", "selector=#box > p:nth-of-type(1) | PLANTED-HTML | "]);
});

test("an embedded document gets segments of its own content", async () => {
  const inner = script("inner", "application/x-inner", async (xhtml) => {
    await xhtml.element("p", "PLANTED-INNER");
  });
  const outer = script("outer", "application/x-outer", async (xhtml, _hints, ctx, handler) => {
    await xhtml.element("p", "outer text");
    const extractor = ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor;
    const metadata = new Metadata();
    metadata.set("tk:resource-name", inner);
    await extractor.parseEmbedded(await RipstreamInputStream.from(BYTES), handler, metadata, ctx);
  });
  const records = await segmentsOf(outer);
  assert.deepEqual(records.map((record) => lines(record.segments)), [["para=1 | outer text | "], ["para=1 | PLANTED-INNER | "]]);
});

test("a truncated parse keeps segments within the content it kept", async () => {
  const long = script("long", "application/x-long", async (xhtml) => {
    for (let index = 0; index < 50; index++) await xhtml.element("p", `paragraph number ${index}`);
  });
  const [record] = await segmentsOf(long, { onOutputLimit: "truncate", limits: { maxOutputChars: 100 } });
  assert.ok(record!.segments!.length > 0);
  for (const segment of record!.segments!) {
    assert.ok(segment.end <= record!.content.length);
    assert.equal(record!.content.slice(segment.start, segment.end), segment.text);
  }
});
