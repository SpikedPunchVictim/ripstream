import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType, ParseContext } from "@spikedpunch/ripstream-core";
import { createDefaultParser } from "../src/index.ts";

async function supporters(type: string): Promise<string[]> {
  const parser = createDefaultParser() as unknown as {
    getParsers(): readonly import("@spikedpunch/ripstream-core").Parser[];
  };
  const ctx = new ParseContext();
  const wanted = MediaType.parseOrThrow(type);
  const names: string[] = [];
  for (const candidate of parser.getParsers()) {
    const types = await candidate.getSupportedTypes(ctx);
    if ([...types].some((supported) => supported.equals(wanted))) names.push(candidate.name);
  }
  return names;
}

test("types the detector emits reach a parser", async () => {
  assert.deepEqual(await supporters("application/x-matroska"), ["MatroskaParser"]);
  assert.deepEqual(await supporters("application/x-parquet"), ["ColumnarParser"]);
  assert.deepEqual(await supporters("image/vnd.dxf"), ["DXFParser"]);
});

/** The parsers selectParsers picks for a type through the registry (aliases and supertypes), best match first. */
async function selected(type: string): Promise<{ name: string; kind: string }[]> {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow(type), new ParseContext());
  return matches.map((match) => ({ name: match.parser.name, kind: match.kind }));
}

test("the 17 ODF types the detector emits beyond the first eight reach OpenDocumentParser exactly (tikajs-68os.12)", async () => {
  const extras = [
    "vnd.sun.xml.writer",
    "vnd.oasis.opendocument.chart",
    "vnd.oasis.opendocument.chart-template",
    "vnd.oasis.opendocument.image",
    "vnd.oasis.opendocument.image-template",
    "vnd.oasis.opendocument.formula",
    "vnd.oasis.opendocument.formula-template",
    "vnd.oasis.opendocument.text-master",
    "vnd.oasis.opendocument.text-web",
    // The x-vnd spellings are aliases of the vnd ones, so they select the same parser.
    "x-vnd.oasis.opendocument.chart",
    "x-vnd.oasis.opendocument.chart-template",
    "x-vnd.oasis.opendocument.image",
    "x-vnd.oasis.opendocument.image-template",
    "x-vnd.oasis.opendocument.formula",
    "x-vnd.oasis.opendocument.formula-template",
    "x-vnd.oasis.opendocument.text-master",
    "x-vnd.oasis.opendocument.text-web",
  ];
  assert.equal(extras.length, 17);
  for (const subtype of extras) {
    const [first] = await selected(`application/${subtype}`);
    assert.deepEqual(first, { name: "OpenDocumentParser", kind: "exact" }, subtype);
  }
});

test("the ZIP based formats that had only the generic ZipParser reach their own parsers (tikajs-68os.13)", async () => {
  for (const [type, parser] of [
    ["application/vnd.geogebra.file", "GeoGebraParser"],
    ["application/vnd.geogebra.slides", "GeoGebraParser"],
    ["application/vnd.geogebra.tool", "GeoGebraParser"],
    ["application/vnd.adobe.indesign-idml-package", "IDMLParser"],
    ["application/x-wacz", "WACZParser"],
    ["application/x-xliff+zip", "XLZParser"],
  ] as const) {
    const [first] = await selected(type);
    assert.deepEqual(first, { name: parser, kind: "exact" }, type);
  }
});

test("an iBooks file is parsed by EpubParser, which claims its type exactly as Tika's does", async () => {
  const [first] = await selected("application/x-ibooks+zip");
  assert.deepEqual(first, { name: "EpubParser", kind: "exact" });
});

test("registration order picks the intended parser for overlapping types", async () => {
  assert.equal((await supporters("audio/mp4"))[0], "MP4Parser");
  assert.equal((await supporters("audio/x-ms-wma"))[0], "AudioParser");
  assert.equal((await supporters("application/rdf+xml"))[0], "XMLParser");
});
