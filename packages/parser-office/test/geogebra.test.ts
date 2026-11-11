import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  MediaType,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
  type Detector,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { GeoGebraParser } from "../src/index.ts";

/*
 * Ported from the cases of Tika 4.2.0's GeoGebraParserTest, with archives built here instead of its fixtures. The
 * expectations are what GeoGebraParser.java, GeoGebraXMLHandler.java and GeoGebraJson.java do when read; none of
 * this was run against a Tika.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';

function geogebra(app: string, version: string, id: string, body: string): string {
  return `${XML_HEAD}<geogebra format="5.0" version="${version}" app="${app}" id="${id}">${body}</geogebra>`;
}

function slide(text: string): string {
  return geogebra(
    "notes",
    "5.2.0.0",
    `slide-${text}`,
    `<construction><element type="inlinetext" label="a"><content val="[{&quot;text&quot;:&quot;${text}\\r\\n&quot;}]"/></element></construction>`,
  );
}

/** A detector standing in for the facade's: by file name, as the real one's extension hint does. */
const detector: Detector = {
  async detect(_stream, metadata) {
    const name = metadata.get("tk:resource-name") ?? "";
    return MediaType.parseOrThrow(
      name.endsWith(".png") ? "image/png" : name.endsWith(".js") ? "application/javascript" : "application/octet-stream",
    );
  },
};

interface Embedded {
  readonly name: string;
  readonly metadata: Metadata;
}

interface Result {
  readonly metadata: Metadata;
  readonly xml: string;
  readonly embedded: Embedded[];
}

function archive(entries: Record<string, string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) files[name] = typeof value === "string" ? strToU8(value) : value;
  return zipSync(files);
}

async function run(entries: Record<string, string | Uint8Array>, context = new ParseContext()): Promise<Result> {
  const resources = new EmbeddedDocumentBytesHandler();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  context.set(CONTEXT_KEYS.DETECTOR, detector);
  const stream = await RipstreamInputStream.from(archive(entries));
  const handler = createOutputHandler("xml");
  const metadata = new Metadata();
  try {
    await new GeoGebraParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return {
    metadata,
    xml: handler.toString(),
    embedded: resources.resources.map((resource) => ({
      name: resource.metadata.get("tk:resource-name") ?? "",
      metadata: resource.metadata,
    })),
  };
}

function byName(result: Result, name: string): Metadata | undefined {
  return result.embedded.find((item) => item.name === name)?.metadata;
}

const WORKSHEET = geogebra(
  "classic",
  "5.0.815.0",
  "0c34397e-e3e1-4d1c-9cb6-fe6e54b1e88f",
  '<construction title="Pythagorean theorem" author="Ada Lovelace" date="15 January 2026">' +
    '<element type="point" label="A"><coords x="1" y="2" z="1"/></element>' +
    '<expression label="text1" exp="&quot;In a right triangle a² + b² = c²&quot;"/>' +
    '<element type="text" label="text1"><caption val="Theorem statement"/></element>' +
    '<element type="inlinetext" label="note1"><content val="[{&quot;text&quot;:&quot;Drag the vertices to explore.\\n&quot;}]"/></element>' +
    "</construction>",
);

const MACRO = geogebra(
  "classic",
  "5.0.815.0",
  "macro-1",
  '<macro cmdName="Midpoint2" toolName="Midpoint tool" toolHelp="Select two points to construct their midpoint" iconFile="" showInToolBar="true">' +
    '<construction title="" author="" date=""><element type="point" label="A"><coords x="0" y="0" z="1"/></element></construction></macro>',
);

test("a worksheet gives its construction metadata, its text, the thumbnail and the script", async () => {
  const result = await run({
    "geogebra_thumbnail.png": PNG,
    "geogebra_javascript.js": "alert(1)",
    "geogebra_defaults2d.xml": "<geogebra/>",
    "geogebra.xml": WORKSHEET,
    "geogebra_macro.xml": MACRO,
  });
  const { metadata } = result;
  assert.equal(metadata.get("dc:title"), "Pythagorean theorem");
  assert.equal(metadata.get("dc:creator"), "Ada Lovelace");
  assert.equal(metadata.get("geogebra:date"), "15 January 2026");
  assert.equal(metadata.get("geogebra:app-name"), "classic");
  assert.equal(metadata.get("geogebra:app-version"), "5.0.815.0");
  assert.equal(metadata.get("geogebra:format-version"), "5.0");
  assert.equal(metadata.get("geogebra:id"), "0c34397e-e3e1-4d1c-9cb6-fe6e54b1e88f");
  assert.equal(metadata.get("geogebra:toolName"), "Midpoint tool");

  assert.match(result.xml, /<p>In a right triangle a² \+ b² = c²<\/p>/);
  assert.match(result.xml, /<p>Theorem statement<\/p>/);
  assert.match(result.xml, /<p>Drag the vertices to explore\.<\/p>/);
  assert.match(result.xml, /<p>Midpoint tool<\/p>/);
  assert.match(result.xml, /<p>Select two points to construct their midpoint<\/p>/);

  // The thumbnail and the script only: the XML parts and the defaults are housekeeping.
  assert.deepEqual(result.embedded.map((item) => item.name).sort(), ["geogebra_javascript.js", "geogebra_thumbnail.png"]);
  assert.equal(byName(result, "geogebra_thumbnail.png")!.get("tk:embedded-resource-type"), "THUMBNAIL");
  assert.equal(byName(result, "geogebra_javascript.js")!.get("tk:embedded-resource-type"), "MACRO");
  assert.equal(byName(result, "geogebra_javascript.js")!.get("tk:internal-path"), "geogebra_javascript.js");
});

test("a tool file gives the tool name and help, no thumbnail and no title", async () => {
  const result = await run({ "geogebra_macro.xml": MACRO });
  assert.equal(result.metadata.get("geogebra:toolName"), "Midpoint tool");
  assert.equal(result.metadata.get("geogebra:app-name"), "classic");
  assert.equal(result.metadata.get("dc:title"), null);
  assert.match(result.xml, /<p>Select two points to construct their midpoint<\/p>/);
  assert.equal(result.embedded.length, 0);
});

test("text objects: literals only, geometry skipped, blank and empty ones dropped", async () => {
  const result = await run({
    "geogebra.xml": geogebra(
      "classic",
      "5.0.1.0",
      "id",
      "<construction>" +
        '<expression label="t1" exp="&quot;plain text&quot;"/>' +
        '<expression label="t2" exp="&quot;Area = &quot; + a"/>' +
        '<expression label="t3" exp="&quot;a&quot;+&quot;b&quot;"/>' +
        '<expression label="f" exp="x^2 + 1"/>' +
        '<expression label="empty" exp="&quot;&quot;"/>' +
        "</construction>",
    ),
  });
  assert.match(result.xml, /<p>plain text<\/p>/);
  assert.match(result.xml, /<p>Area =<\/p>/);
  assert.match(result.xml, /<p>ab<\/p>/);
  assert.doesNotMatch(result.xml, /x\^2/);
});

test("blank construction attributes are not set, and a macro does not override the worksheet's metadata", async () => {
  const result = await run({
    "geogebra.xml": geogebra(
      "classic",
      "5.0.1.0",
      "doc-id",
      '<construction title="Worksheet" author="Ada" date="today"><expression label="t" exp="&quot;Body&quot;"/></construction>',
    ),
    "geogebra_macro.xml": geogebra(
      "other",
      "9.9.9.9",
      "macro-id",
      '<macro cmdName="Mid" toolName="Midpoint" toolHelp="Two points"><construction title="Macro" author="Bob" date="never"/></macro>',
    ),
  });
  const { metadata } = result;
  assert.equal(metadata.get("dc:title"), "Worksheet");
  assert.equal(metadata.get("dc:creator"), "Ada");
  assert.equal(metadata.get("geogebra:date"), "today");
  assert.equal(metadata.get("geogebra:app-name"), "classic");
  assert.equal(metadata.get("geogebra:app-version"), "5.0.1.0");
  assert.equal(metadata.get("geogebra:id"), "doc-id");
  assert.equal(metadata.get("geogebra:toolName"), "Midpoint");
  assert.match(result.xml, /<p>Body<\/p>/);
  assert.match(result.xml, /<p>Two points<\/p>/);

  const blank = await run({ "geogebra.xml": geogebra("classic", "5.4", "x", '<construction title="  " author="" date=" "/>') });
  assert.equal(blank.metadata.get("dc:title"), null);
  assert.equal(blank.metadata.get("dc:creator"), null);
  assert.equal(blank.metadata.get("geogebra:date"), null);
});

test("a tool's cmdName stands in for a blank toolName", async () => {
  const result = await run({
    "geogebra_macro.xml": geogebra("classic", "5", "m", '<macro cmdName="Mid2" toolName=" " toolHelp=""/>'),
  });
  assert.deepEqual(result.metadata.getAll("geogebra:toolName"), ["Mid2"]);
});

test("slides follow structure.json, count as pages, and only the first slide's thumbnail is emitted", async () => {
  const result = await run({
    "structure.json": '{"chapters":[{"pages":[{"elements":[{"id":"_slide1"},{"id":"_slide0"}]}]}]}',
    "_slide0/geogebra_thumbnail.png": PNG,
    "_slide0/geogebra.xml": slide("First slide text"),
    "_slide0/geogebra_javascript.js": "alert(0)",
    "_slide1/geogebra_thumbnail.png": PNG,
    "_slide1/geogebra.xml": slide("Second slide text"),
    "_slide1/geogebra_javascript.js": "alert(1)",
    "_slide0/8c6976e5b541/photo.png": PNG,
  });
  assert.equal(result.metadata.get("xmpTPg:NPages"), "2");
  assert.equal(result.metadata.get("geogebra:app-name"), "notes");
  assert.ok(result.xml.includes('<div class="slide">'));
  assert.ok(result.xml.indexOf("Second slide text") < result.xml.indexOf("First slide text"), "structure.json lists _slide1 first");

  // The thumbnail of the first slide in order (_slide1), the two scripts and the picture.
  assert.deepEqual(result.embedded.map((item) => item.name).sort(), [
    "_slide0/8c6976e5b541/photo.png",
    "_slide0/geogebra_javascript.js",
    "_slide1/geogebra_javascript.js",
    "_slide1/geogebra_thumbnail.png",
  ]);
  assert.equal(byName(result, "_slide1/geogebra_thumbnail.png")!.get("tk:embedded-resource-type"), "THUMBNAIL");
  const picture = byName(result, "_slide0/8c6976e5b541/photo.png")!;
  assert.equal(picture.get("tk:embedded-resource-type"), "INLINE");
  assert.equal(picture.get("Content-Type"), "image/png");
  assert.equal(picture.get("tk:internal-path"), "_slide0/8c6976e5b541/photo.png");
  // _slide0 is the second page in structure.json's order.
  assert.equal(picture.get("tk:page:numbers"), "2");
  assert.equal(picture.get("tk:page:number"), "2");
  assert.equal(byName(result, "_slide0/geogebra_javascript.js")!.get("tk:embedded-resource-type"), "MACRO");
  assert.equal(byName(result, "_slide0/geogebra_javascript.js")!.get("tk:page:number"), "2");
});

test("slides without a usable structure.json go in numeric order, leading zeros aside", async () => {
  const result = await run({
    "structure.json": "not json",
    "_slide10/geogebra.xml": slide("Tenth"),
    "_slide007/geogebra.xml": slide("Seventh"),
    "_slide2/geogebra.xml": slide("Second"),
  });
  assert.equal(result.metadata.get("xmpTPg:NPages"), "3");
  const at = (text: string): number => result.xml.indexOf(text);
  assert.ok(at("Second") < at("Seventh") && at("Seventh") < at("Tenth"), result.xml);
  // The CRLF that ends the text run does not leak into the paragraph.
  assert.match(result.xml, /<p>Second<\/p>/);
});

test("structure.json only orders the slides it lists; the others follow in numeric order", async () => {
  const result = await run({
    "structure.json": '{"chapters":[{"pages":[{"elements":[{"id":"_slide2"},{"id":"_nothere"}]}]}]}',
    "_slide0/geogebra.xml": slide("Zero"),
    "_slide1/geogebra.xml": slide("One"),
    "_slide2/geogebra.xml": slide("Two"),
  });
  const at = (text: string): number => result.xml.indexOf(text);
  assert.ok(at("Two") < at("Zero") && at("Zero") < at("One"), result.xml);
  // The id that names no slide is not a slide: it is neither a page nor a div.
  assert.equal(result.metadata.get("xmpTPg:NPages"), "3");
  assert.equal(result.xml.split('<div class="slide">').length - 1, 3);
});

test("a slide number with more digits than an int holds sorts without failing", async () => {
  const result = await run({
    "structure.json": '{"chapters":[{"pages":[{"elements":[{"id":"_slide0"},{"id":"_slide99999999999"}]}]}]}',
    "_slide0/geogebra.xml": '<geogebra format="5.0"></geogebra>',
    "_slide99999999999/geogebra.xml": '<geogebra format="5.0"></geogebra>',
  });
  assert.equal(result.metadata.get("xmpTPg:NPages"), "2");
});

test("the thumbnail falls back to the next slide that has one", async () => {
  const result = await run({
    "_slide0/geogebra.xml": slide("Zero"),
    "_slide1/geogebra.xml": slide("One"),
    "_slide2/geogebra.xml": slide("Two"),
    "_slide1/geogebra_thumbnail.png": PNG,
    "_slide2/geogebra_thumbnail.png": PNG,
  });
  assert.deepEqual(result.embedded.map((item) => item.name), ["_slide1/geogebra_thumbnail.png"]);
  assert.equal(byName(result, "_slide1/geogebra_thumbnail.png")!.get("tk:embedded-resource-type"), "THUMBNAIL");
});

test("a root worksheet alongside slides keeps its metadata and both texts are written", async () => {
  const result = await run({
    "geogebra.xml": geogebra("notes", "5.2.0.0", "root-id", '<construction title="Root"><expression label="t" exp="&quot;Root text&quot;"/></construction>'),
    "_slide0/geogebra.xml": slide("Slide text"),
  });
  assert.equal(result.metadata.get("dc:title"), "Root");
  assert.match(result.xml, /Root text/);
  assert.match(result.xml, /Slide text/);
});

test("a malformed slide is recorded and does not stop the next slide, its div or the thumbnail", async () => {
  const result = await run({
    "structure.json": '{"chapters":[{"pages":[{"elements":[{"id":"_slide0"},{"id":"_slide1"}]}]}]}',
    "_slide0/geogebra.xml":
      `${XML_HEAD}<geogebra><construction><expression label="t" exp="&quot;Broken&quot;"/><unclosed>`,
    "_slide1/geogebra.xml": slide("Fine"),
    "_slide1/geogebra_thumbnail.png": PNG,
  });
  assert.match(result.xml, /Fine/);
  // The text that came before the break is kept, as SAX events delivered before the error are.
  assert.match(result.xml, /Broken/);
  assert.equal(result.xml.split('<div class="slide">').length - 1, 2);
  assert.equal(result.xml.split("</div>").length - 1, 2);
  assert.equal(result.metadata.getAll("tk:exception:embedded-stream-exception").length, 1);
  assert.ok(byName(result, "_slide1/geogebra_thumbnail.png") !== undefined);
});

test("a tool's icon is its thumbnail and is not emitted twice", async () => {
  const icon = "5d41402abc4b2a76b9719d911017c592/Midpoint.png";
  const macro = geogebra("classic", "5.0.815.0", "tool-1", `<macro cmdName="Mid" toolName="Midpoint" toolHelp="Two points" iconFile="${icon}"><construction/></macro>`);
  const result = await run({ "geogebra_macro.xml": macro, [icon]: PNG });
  assert.deepEqual(result.embedded.map((item) => item.name), [icon]);
  assert.equal(byName(result, icon)!.get("tk:embedded-resource-type"), "THUMBNAIL");
  assert.equal(byName(result, icon)!.get("Content-Type"), null);

  // An icon that is not in the zip: no thumbnail, no error.
  const missing = await run({ "geogebra_macro.xml": macro });
  assert.equal(missing.embedded.length, 0);
  assert.equal(missing.metadata.get("tk:exception:embedded-stream-exception"), null);
});

test("a worksheet's own thumbnail beats a tool icon, which is then just a picture", async () => {
  const icon = "5d41402abc4b2a76b9719d911017c592/Midpoint.png";
  const result = await run({
    "geogebra.xml": geogebra("classic", "5.0.815.0", "ws-1", "<construction/>"),
    "geogebra_macro.xml": geogebra("classic", "5.0.815.0", "ws-1", `<macro cmdName="Mid" toolName="Midpoint" iconFile="${icon}"><construction/></macro>`),
    "geogebra_thumbnail.png": PNG,
    [icon]: PNG,
  });
  assert.equal(byName(result, "geogebra_thumbnail.png")!.get("tk:embedded-resource-type"), "THUMBNAIL");
  assert.equal(byName(result, icon)!.get("tk:embedded-resource-type"), "INLINE");
});

test("housekeeping names are only housekeeping at the root and in slide directories", async () => {
  const result = await run({
    "geogebra.xml": geogebra("classic", "5.0.1.0", "id", "<construction/>"),
    "dir/geogebra_javascript.js": "alert(1)",
    "dir/geogebra.xml": "<geogebra/>",
    "data.bin": new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(result.embedded.map((item) => item.name).sort(), ["data.bin", "dir/geogebra.xml", "dir/geogebra_javascript.js"]);
  assert.equal(byName(result, "dir/geogebra_javascript.js")!.get("tk:embedded-resource-type"), "ATTACHMENT");
  assert.equal(byName(result, "data.bin")!.get("tk:embedded-resource-type"), "ATTACHMENT");
  assert.equal(byName(result, "data.bin")!.get("tk:page:number"), null);
});

test("text runs of a content value: nested text fields, null and object values, one paragraph per line", async () => {
  const content = (json: string): string =>
    geogebra("notes", "5", "c", `<construction><element type="inlinetext"><content val="${json.replace(/"/g, "&quot;")}"/></element></construction>`);
  const nested = await run({ "geogebra.xml": content('[{"text":"Line one\\nLine two"},{"rows":[{"text":"Cell"},{"text":null},{"text":{"text":"skipped"}}]}]') });
  // The runs are joined with nothing between them and then split into lines (GeoGebraXMLHandler.handleContent), so
  // the last line of one run and the first of the next share a paragraph.
  assert.match(nested.xml, /<p>Line one<\/p>/);
  assert.match(nested.xml, /<p>Line twoCell<\/p>/);
  assert.doesNotMatch(nested.xml, /skipped/);
  // Not a JSON document, or not JSON at all: nothing, and no failure.
  for (const val of ["plain string", "[{\"text\":\"cut off", "{}", " "]) {
    const result = await run({ "geogebra.xml": content(val) });
    assert.doesNotMatch(result.xml, /cut off|plain string/, val);
    assert.equal(result.metadata.get("tk:exception:embedded-stream-exception"), null, val);
  }
});

test("supports the three GeoGebra types", () => {
  const types = [...new GeoGebraParser().getSupportedTypes()].map((type) => type.toString()).sort();
  assert.deepEqual(types, [
    "application/vnd.geogebra.file",
    "application/vnd.geogebra.slides",
    "application/vnd.geogebra.tool",
  ]);
});

test("a hostile archive is refused, not expanded: an entry bomb and too many entries", async () => {
  const bomb = archive({ "geogebra.xml": new Uint8Array(5_000_000), "geogebra_macro.xml": new Uint8Array(5_000_000) });
  const stream = await RipstreamInputStream.from(bomb);
  await assert.rejects(
    new GeoGebraParser().parse(stream, createOutputHandler("xml"), new Metadata(), new ParseContext()),
    LimitExceededError,
  );
  await stream.close();

  const many: Record<string, string> = { "geogebra.xml": WORKSHEET };
  for (let index = 0; index < 20; index++) many[`extra/${index}.txt`] = "x";
  const tight = new ParseContext({ limits: { maxZipEntries: 10 } });
  const crowded = await RipstreamInputStream.from(archive(many));
  await assert.rejects(
    new GeoGebraParser().parse(crowded, createOutputHandler("xml"), new Metadata(), tight),
    LimitExceededError,
  );
  await crowded.close();
});

test("a bomb in an embedded picture is refused too", async () => {
  const stream = await RipstreamInputStream.from(archive({ "geogebra.xml": WORKSHEET, "pictures/bomb.bin": new Uint8Array(5_000_000) }));
  await assert.rejects(
    new GeoGebraParser().parse(stream, createOutputHandler("xml"), new Metadata(), (() => {
      const context = new ParseContext();
      context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, new EmbeddedDocumentBytesHandler());
      context.set(CONTEXT_KEYS.DETECTOR, detector);
      return context;
    })()),
    LimitExceededError,
  );
  await stream.close();
});

/** The two slides of a Notes file, whose structure.json lists the second first. */
const REVERSED = '{"chapters":[{"pages":[{"elements":[{"id":"_slide1"},{"id":"_slide0"}]}]}]}';
const MEBIBYTE = 1024 * 1024;
/** A ratio no padding of spaces can pass, lifted so that only the length of the entry decides. */
const PADDED = (): ParseContext => new ParseContext({ limits: { maxDecompressionRatio: 1_000_000 } });

test("a structure.json of a mebibyte is read, and one byte more is not", async () => {
  for (const [padding, listed] of [
    [MEBIBYTE - REVERSED.length, true],
    [MEBIBYTE - REVERSED.length + 1, false],
  ] as const) {
    const result = await run(
      {
        "structure.json": REVERSED + " ".repeat(padding),
        "_slide0/geogebra.xml": slide("Zero"),
        "_slide1/geogebra.xml": slide("One"),
      },
      PADDED(),
    );
    const at = (text: string): number => result.xml.indexOf(text);
    assert.equal(at("One") < at("Zero"), listed, `${REVERSED.length + padding} characters`);
  }
});

/** A geogebra.xml with one rich-text content value of the given JSON. */
function withContent(json: string): Record<string, string> {
  return {
    "geogebra.xml": geogebra(
      "notes",
      "5",
      "c",
      `<construction><element type="inlinetext" label="a"><content val="${json.replaceAll('"', "&quot;")}"/></element></construction>`,
    ),
  };
}

test("a content value of a mebibyte is read, and one character more is not", async () => {
  const json = '[{"text":"Kept"}';
  for (const [length, kept] of [
    [MEBIBYTE, true],
    [MEBIBYTE + 1, false],
  ] as const) {
    const result = await run(withContent(json + " ".repeat(length - json.length - 1) + "]"), PADDED());
    assert.equal(result.xml.includes("<p>Kept</p>"), kept, `${length} characters`);
  }
});

test("content JSON nested a thousand deep is read, and one level more gives no text", async () => {
  const nested = (arrays: number): string => "[".repeat(arrays) + '{"text":"Deep"}' + "]".repeat(arrays);
  // The object sits one level below the arrays that hold it.
  assert.match((await run(withContent(nested(999)))).xml, /<p>Deep<\/p>/);
  assert.doesNotMatch((await run(withContent(nested(1000)))).xml, /Deep/);
});

test("a content value splits into paragraphs at a lone CR, a lone LF and a CRLF", async () => {
  const result = await run(withContent('[{"text":"A\\rB\\nC\\r\\nD"}]'));
  assert.deepEqual([...result.xml.matchAll(/<p>([^<]*)<\/p>/g)].map((match) => match[1]), ["A", "B", "C", "D"]);
});

test("a structure.json inside a slide directory is an embedded file, not housekeeping", async () => {
  const result = await run({
    "structure.json": REVERSED,
    "_slide0/geogebra.xml": slide("Zero"),
    "_slide0/structure.json": "{}",
  });
  assert.deepEqual(result.embedded.map((item) => item.name), ["_slide0/structure.json"]);
});

test("the tool name is trimmed as metadata, as it is as text", async () => {
  const result = await run({
    "geogebra_macro.xml": geogebra("classic", "5", "m", '<macro cmdName="Mid2" toolName="  Midpoint tool  " toolHelp=""/>'),
  });
  assert.deepEqual(result.metadata.getAll("geogebra:toolName"), ["Midpoint tool"]);
});

test("the construction inside a macro does not give the document its title, author or date", async () => {
  const result = await run({
    "geogebra_macro.xml": geogebra(
      "classic",
      "5",
      "m",
      '<macro cmdName="Mid2" toolName="Mid" toolHelp=""><construction title="Inner" author="Someone" date="Today"/></macro>',
    ),
  });
  assert.equal(result.metadata.get("dc:title"), null);
  assert.equal(result.metadata.get("dc:creator"), null);
  assert.equal(result.metadata.get("geogebra:date"), null);
});
