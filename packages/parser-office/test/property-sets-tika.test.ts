import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata } from "@spikedpunch/ripstream-core";
import { applyPropertySetMetadata, parsePropertySets } from "../src/property-sets.ts";
import {
  DOCUMENT_SUMMARY_ID,
  filetimeOf,
  propertySet,
  type Prop,
  type Section,
  SUMMARY_INFORMATION_ID,
  USER_DEFINED_ID,
} from "./property-set-builder.ts";

/*
 * The keys and value formats below are Tika 4.2.0's (SummaryExtractor through OfficeParser, /rmeta of an OLE2 file holding only
 * these streams), recorded for tikajs-nb4y.
 */

function summary(props: readonly Prop[]): Metadata {
  const metadata = new Metadata();
  applyPropertySetMetadata(metadata, parsePropertySets(propertySet([{ fmtid: SUMMARY_INFORMATION_ID, props }])));
  return metadata;
}

function documentSummary(props: readonly Prop[], custom?: Section): Metadata {
  const metadata = new Metadata();
  const sections: Section[] = [{ fmtid: DOCUMENT_SUMMARY_ID, props }];
  if (custom !== undefined) sections.push(custom);
  applyPropertySetMetadata(metadata, parsePropertySets(propertySet(sections)));
  return metadata;
}

const s = (id: number, value: string): Prop => ({ id, type: "string", value });
const n = (id: number, value: number): Prop => ({ id, type: "int", value });
const t = (id: number, value: bigint): Prop => ({ id, type: "filetime", value });

test("a SummaryInformation stream is always TotalTime, 0 when it has no edit time", () => {
  assert.equal(summary([]).get("extended-properties:TotalTime"), "0");
  assert.equal(summary([s(2, "T")]).get("extended-properties:TotalTime"), "0");
});

test("the edit time is the raw FILETIME ticks", () => {
  assert.equal(summary([t(10, 62_070_000_000n)]).get("extended-properties:TotalTime"), "62070000000");
  assert.equal(summary([t(10, 132_277_719_678_910_000n)]).get("extended-properties:TotalTime"), "132277719678910000");
});

test("the edit time is kept to the millisecond, as POI reads it through a Date (testDGN8.dgn: 24673 ticks are 20000)", () => {
  assert.equal(summary([t(10, 24_673n)]).get("extended-properties:TotalTime"), "20000");
});

test("dates are written to the second, with no milliseconds", () => {
  const metadata = summary([t(12, filetimeOf("2020-03-04T05:06:07.891Z")), t(13, filetimeOf("2020-03-04T06:06:07Z"))]);
  assert.equal(metadata.get("dcterms:created"), "2020-03-04T05:06:07Z");
  assert.equal(metadata.get("dcterms:modified"), "2020-03-04T06:06:07Z");
});

test("a date property of another type ends the SummaryInformation there, as POI's ClassCastException ends Tika's", () => {
  const text = [s(2, "T"), s(9, "9"), s(18, "App")];
  const counts = [n(14, 2), n(19, 1)];
  // created is read first, then modified, then last printed, then the edit time
  const created = summary([...text, n(12, 5), t(13, 1n), ...counts]);
  assert.equal(created.get("dc:title"), "T");
  assert.equal(created.get("extended-properties:Application"), "App");
  for (const key of ["dcterms:created", "dcterms:modified", "extended-properties:TotalTime", "meta:page-count", "extended-properties:DocSecurity"]) {
    assert.equal(created.get(key), null, key);
  }
  const modified = summary([t(12, 1n), n(13, 5), ...counts]);
  assert.equal(modified.get("dcterms:created"), "1601-01-01T00:00:00Z");
  assert.equal(modified.get("dcterms:modified"), null);
  const printed = summary([t(12, 1n), t(13, 1n), n(11, 5), t(10, 1n), ...counts]);
  assert.equal(printed.get("dcterms:modified"), "1601-01-01T00:00:00Z");
  assert.equal(printed.get("meta:print-date"), null);
  assert.equal(printed.get("extended-properties:TotalTime"), null);
  const edit = summary([t(11, 1n), n(10, 5), ...counts]);
  assert.equal(edit.get("meta:print-date"), "1601-01-01T00:00:00Z");
  assert.equal(edit.get("extended-properties:TotalTime"), null);
  assert.equal(edit.get("meta:page-count"), null);
});

test("the last printed date is meta:print-date, and a zero FILETIME is 1601-01-01", () => {
  const metadata = summary([t(11, filetimeOf("2020-03-04T05:06:07Z")), t(12, 0n), t(13, 0n)]);
  assert.equal(metadata.get("meta:print-date"), "2020-03-04T05:06:07Z");
  assert.equal(metadata.get("dcterms:created"), "1601-01-01T00:00:00Z");
  assert.equal(metadata.get("dcterms:modified"), "1601-01-01T00:00:00Z");
  assert.equal(metadata.get("meta:lastPrinted"), null);
});

test("a date property that is not there is not set", () => {
  const metadata = summary([s(2, "T")]);
  assert.equal(metadata.get("dcterms:created"), null);
  assert.equal(metadata.get("meta:print-date"), null);
});

test("the SummaryInformation text properties have Tika's keys", () => {
  const metadata = summary([
    s(2, "Title"),
    s(3, "Subject"),
    s(4, "Author"),
    s(5, "kw1 kw2"),
    s(6, "Comments"),
    s(7, "Normal.dotm"),
    s(8, "LastAuth"),
    s(9, "7"),
    s(18, "Microsoft Word"),
    n(19, 2),
  ]);
  assert.equal(metadata.get("dc:title"), "Title");
  assert.deepEqual(metadata.getAll("dc:subject"), ["kw1 kw2", "Subject"]);
  assert.equal(metadata.get("meta:keyword"), "kw1 kw2");
  assert.equal(metadata.get("dc:creator"), "Author");
  assert.equal(metadata.get("w:Comments"), "Comments");
  assert.equal(metadata.get("extended-properties:Template"), "Normal.dotm");
  assert.equal(metadata.get("meta:last-author"), "LastAuth");
  assert.equal(metadata.get("cp:revision"), "7");
  assert.equal(metadata.get("extended-properties:Application"), "Microsoft Word");
  assert.equal(metadata.get("extended-properties:DocSecurity"), "2");
  for (const key of ["pdf:Keywords", "dc:description", "cp:template", "meta:editTime", "extended-properties:Security"]) {
    assert.equal(metadata.get(key), null, key);
  }
});

test("a title keeps its spaces and a blank text property is not set", () => {
  const metadata = summary([s(2, "  padded  "), s(4, "   "), s(3, ""), s(6, " ")]);
  assert.equal(metadata.get("dc:title"), "  padded  ");
  for (const key of ["dc:creator", "dc:subject", "w:Comments"]) assert.equal(metadata.get(key), null, key);
});

test("authors and managers split at semicolons, each as written, without the blank ones", () => {
  assert.deepEqual(summary([s(4, "A; B")]).getAll("dc:creator"), ["A", " B"]);
  assert.deepEqual(summary([s(4, "A; ;B;")]).getAll("dc:creator"), ["A", "B"]);
  assert.equal(summary([s(4, ";")]).get("dc:creator"), null);
  assert.deepEqual(documentSummary([s(14, "M1; M2")]).getAll("extended-properties:Manager"), ["M1", " M2"]);
});

test("the counts are set when they are above 0, page count as both meta:page-count and xmpTPg:NPages", () => {
  const metadata = summary([n(14, 5), n(15, 100), n(16, 600)]);
  assert.equal(metadata.get("meta:page-count"), "5");
  assert.equal(metadata.get("xmpTPg:NPages"), "5");
  assert.equal(metadata.get("meta:word-count"), "100");
  assert.equal(metadata.get("meta:character-count"), "600");
  const none = summary([n(14, 0), n(15, 0), n(16, -3), n(19, 0)]);
  for (const key of ["meta:page-count", "xmpTPg:NPages", "meta:word-count", "meta:character-count", "extended-properties:DocSecurity"]) {
    assert.equal(none.get(key), null, key);
  }
});

test("the DocumentSummaryInformation counts, and the slide count is the page count too", () => {
  const metadata = documentSummary([s(2, "Cat"), n(5, 11), n(6, 12), n(7, 13), n(8, 14), n(9, 15), n(10, 16), s(15, "Comp")]);
  assert.equal(metadata.get("cp:category"), "Cat");
  assert.equal(metadata.get("meta:line-count"), "11");
  assert.equal(metadata.get("meta:paragraph-count"), "12");
  assert.equal(metadata.get("meta:slide-count"), "13");
  assert.equal(metadata.get("xmpTPg:NPages"), "13");
  assert.equal(metadata.get("extended-properties:Company"), "Comp");
  for (const key of ["meta:note-count", "meta:hidden-slide-count", "meta:multimedia-clip-count", "extended-properties:AppVersion"]) {
    assert.equal(metadata.get(key), null, key);
  }
  assert.equal(documentSummary([n(5, 0), n(6, 0), n(7, 0)]).size(), 0);
});

test("a slide count is the page count over the page count of the SummaryInformation stream", () => {
  const metadata = new Metadata();
  applyPropertySetMetadata(metadata, parsePropertySets(propertySet([{ fmtid: SUMMARY_INFORMATION_ID, props: [n(14, 2)] }])));
  applyPropertySetMetadata(metadata, parsePropertySets(propertySet([{ fmtid: DOCUMENT_SUMMARY_ID, props: [n(7, 9)] }])));
  assert.equal(metadata.get("meta:page-count"), "2");
  assert.equal(metadata.get("xmpTPg:NPages"), "9");
});

test("custom properties are the second section's, named by its dictionary, any type as text", () => {
  const metadata = documentSummary([], {
    fmtid: USER_DEFINED_ID,
    props: [
      s(2, "hello"),
      n(3, 42),
      { id: 4, type: "bool", value: true },
      t(5, filetimeOf("2020-03-04T05:06:07.891Z")),
      { id: 6, type: "double", value: 3.5 },
      s(7, ""),
      { id: 8, type: "uint", value: 4_000_000_000 },
      s(9, " x "),
      n(10, -3),
    ],
    dictionary: { 2: "str", 3: "int", 4: "bool", 5: "date", 6: "dbl", 7: "empty", 8: "ui4", 9: "pad", 10: "neg" },
  });
  const expected: Record<string, string> = {
    "custom:str": "hello",
    "custom:int": "42",
    "custom:bool": "true",
    "custom:date": "2020-03-04T05:06:07Z",
    "custom:dbl": "3.5",
    "custom:empty": "",
    "custom:ui4": "-294967296",
    "custom:pad": " x ",
    "custom:neg": "-3",
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(metadata.get(key), value, key);
});

test("a dictionary only names the properties of the second section of a DocumentSummaryInformation stream", () => {
  const props = [s(2, "hello")];
  const first = new Metadata();
  applyPropertySetMetadata(first, parsePropertySets(propertySet([{ fmtid: USER_DEFINED_ID, props, dictionary: { 2: "z" } }])));
  assert.equal(first.get("custom:z"), null);
  assert.equal(first.get("cp:category"), "hello");
  const inSummary = new Metadata();
  applyPropertySetMetadata(
    inSummary,
    parsePropertySets(propertySet([{ fmtid: SUMMARY_INFORMATION_ID, props, dictionary: { 2: "z" } }])),
  );
  assert.equal(inSummary.get("custom:z"), null);
  assert.equal(inSummary.get("dc:title"), "hello");
});

test("the first section's format id decides which properties these are", () => {
  const metadata = new Metadata();
  applyPropertySetMetadata(
    metadata,
    parsePropertySets(propertySet([{ fmtid: new Array(16).fill(0), props: [s(2, "hello")] }])),
  );
  assert.equal(metadata.size(), 0);
});

test("a custom property with no dictionary name is not set", () => {
  const metadata = documentSummary([], { fmtid: USER_DEFINED_ID, props: [s(2, "hello")] });
  assert.equal(metadata.get("custom:2"), null);
});
