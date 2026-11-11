import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, MediaType, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DifParser, createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * Tika's DIFParser (tika-parser-miscoffice-module) with its DIFContentHandler. DIFParserTest reads Zamora2010.dif and expects
 * dif:DIF-Entry_ID and dif:DIF-Metadata_Name in the metadata and, in the text, "Title: ...", "Southernmost_Latitude : 78.833" and
 * the other three bounds. The document below has the shape of that file. Read from Tika source, not run against a Tika.
 */

const encoder = new TextEncoder();
const ripstream = createRipstream();

const DIF = `<?xml version="1.0" encoding="UTF-8"?>
        <DIF xmlns="http://gcmd.gsfc.nasa.gov/Aboutus/xml/dif/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <Entry_ID>00794186-48f9-11e3-9dcb-00c0f03d5b7c</Entry_ID>
          <Entry_Title>Zamora 2010 Using Sediment Geochemistry</Entry_Title>
          <Parameters>
            <Category>EARTH SCIENCE</Category>
            <Topic>PALEOCLIMATE</Topic>
          </Parameters>
          <Parameters>
            <Category>EARTH SCIENCE</Category>
            <Topic>LAND SURFACE</Topic>
          </Parameters>
          <Spatial_Coverage>
            <Southernmost_Latitude>78.833</Southernmost_Latitude>
            <Northernmost_Latitude>79.016</Northernmost_Latitude>
            <Westernmost_Longitude>11.64</Westernmost_Longitude>
            <Easternmost_Longitude>13.34</Easternmost_Longitude>
          </Spatial_Coverage>
          <Data_Center>
            <Data_Center_Name>
              <Short_Name>ACADIS</Short_Name>
            </Data_Center_Name>
          </Data_Center>
          <Metadata_Name>ACADIS IDN DIF</Metadata_Name>
        </DIF>
`;

async function parseDirect(xml: string, parser: DifParser = new DifParser()): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(encoder.encode(xml));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await parser.parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("the DIF parser claims application/dif+xml, and the default registry sends it there, not to the XML parser", async () => {
  assert.deepEqual([...(await new DifParser().getSupportedTypes())].map(String), ["application/dif+xml"]);
  const [first] = await createDefaultParser().selectParsers(MediaType.parseOrThrow("application/dif+xml"), new ParseContext());
  assert.equal(first?.parser.name, "DIFParser");
  assert.equal(first?.kind, "exact");
});

test("every leaf element's path becomes a dif: metadata key, as DIFParserTest expects", async () => {
  const { metadata } = await parseDirect(DIF);
  assert.equal(metadata.get("dif:DIF-Entry_ID"), "00794186-48f9-11e3-9dcb-00c0f03d5b7c");
  assert.equal(metadata.get("dif:DIF-Metadata_Name"), "ACADIS IDN DIF");
  assert.equal(metadata.get("dif:DIF-Data_Center-Data_Center_Name-Short_Name"), "ACADIS");
  assert.deepEqual(metadata.getAll("dif:DIF-Parameters-Category"), ["EARTH SCIENCE", "EARTH SCIENCE"]);
  assert.deepEqual(metadata.getAll("dif:DIF-Parameters-Topic"), ["PALEOCLIMATE", "LAND SURFACE"]);
});

test("the title and the four bounds of the spatial coverage are the text, as DIFParserTest expects", async () => {
  const { text } = await parseDirect(DIF);
  assert.match(text, /Title: Zamora 2010 Using Sediment Geochemistry/);
  assert.match(text, /Southernmost_Latitude : 78\.833/);
  assert.match(text, /Northernmost_Latitude : 79\.016/);
  assert.match(text, /Westernmost_Longitude : 11\.64/);
  assert.match(text, /Easternmost_Longitude : 13\.34/);
  // Only those are written: the other elements are metadata only.
  assert.doesNotMatch(text, /PALEOCLIMATE|ACADIS/);
});

test("the text is shaped as DIFContentHandler writes it: an h3 title, then a Geographic Data table of td pairs", async () => {
  const result = await ripstream.parse(encoder.encode(DIF), { filename: "z.dif", handlerType: "xml" });
  assert.match(result.text, /<h3>Title: Zamora 2010 Using Sediment Geochemistry<\/h3>/);
  assert.match(result.text, /<h3>Geographic Data: <\/h3>/);
  assert.match(result.text, /<table>[\s\S]*<tr><td>Southernmost_Latitude : <\/td><td>78\.833<\/td><\/tr>[\s\S]*<\/table>/);
});

test("a DIF through the whole library keeps its detected type and has no Content-Encoding written", async () => {
  const result = await ripstream.parse(encoder.encode(DIF), { filename: "z.dif" });
  assert.equal(result.metadata.get("Content-Type"), "application/dif+xml");
  assert.equal(result.metadata.get("dif:DIF-Entry_ID"), "00794186-48f9-11e3-9dcb-00c0f03d5b7c");
  assert.match(result.text, /Southernmost_Latitude : 78\.833/);
});

test("a document with no text between its tags ends where Tika's handler fails: an element whose text event is missing", async () => {
  // DIFContentHandler pops the data stack once per element end, and pushes it once per characters() event. A compact
  // document has no whitespace between tags, so the root's end pops an empty stack: Java throws EmptyStackException,
  // which here is a MalformedDocumentError. What came before is kept.
  const metadata = new Metadata();
  const stream = await RipstreamInputStream.from(encoder.encode("<DIF><Entry_ID>x</Entry_ID></DIF>"));
  try {
    await assert.rejects(
      new DifParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext()),
      (error: Error) => error.name === "MalformedDocumentError",
    );
  } finally {
    await stream.close();
  }
  assert.equal(metadata.get("dif:DIF-Entry_ID"), "x");
});

test("a malformed document is a MalformedDocumentError", async () => {
  await assert.rejects(parseDirect("<DIF>\n<a>x</b>\n</DIF>"), (error: Error) => error.name === "MalformedDocumentError");
});

test("hostile: nesting past the cap is a LimitExceededError, not a stack of a hundred thousand names", async () => {
  const deep = `<DIF>\n${"<a>\n".repeat(100_000)}x`;
  await assert.rejects(parseDirect(deep), (error: Error) => error.name === "LimitExceededError");
});

test("hostile: a leaf whose path is longer than 1024 characters writes no key, as Metadata.add(KeyPrefix) skips it", async () => {
  const name = "n".repeat(600);
  const { metadata } = await parseDirect(`<DIF>\n<${name}>\n<${name}>\nv</${name}>\n</${name}>\n</DIF>`);
  assert.equal(metadata.names().filter((key) => key.startsWith("dif:")).length, 0);
});

test("hostile: twenty thousand leaves under a deep path are bounded in time and in metadata names", async () => {
  // Each leaf at depth 1000 would otherwise build a key out of the whole stack: twenty thousand of them is 2*10^7 steps.
  const open = "<a>\n".repeat(1000);
  const close = "</a>\n".repeat(1000);
  const started = performance.now();
  const { metadata } = await parseDirect(`<DIF>\n${open}${"<b>\nv</b>\n".repeat(20_000)}${close}</DIF>`);
  assert.ok(performance.now() - started < 20_000, "the parse took too long");
  assert.equal(metadata.names().filter((key) => key.startsWith("dif:")).length, 0, "a path of 1002 names is over the key cap and writes nothing");
});

test("hostile: text with no element and no newline is bounded by the output limit", async () => {
  const hostile = `<DIF>\n<Entry_Title>${"x".repeat(5_000_000)}</Entry_Title>\n</DIF>`;
  await assert.rejects(
    ripstream.parse(encoder.encode(hostile), { filename: "big.dif", limits: { maxOutputChars: 10_000 } }),
    (error: Error) => error.name === "LimitExceededError" || error.name === "WriteLimitReachedError",
  );
});

test("a leaf key of exactly 1024 characters is written, one of 1025 is not", async () => {
  const keyed = async (length: number): Promise<number> => {
    const name = "n".repeat(length);
    const { metadata } = await parseDirect(`<${name}>v</${name}>`);
    return metadata.names().filter((key) => key.startsWith("dif:")).length;
  };
  assert.equal(await keyed(1024), 1);
  assert.equal(await keyed(1025), 0);
});

test("the first 10,000 distinct key names are written and the next is not", async () => {
  // Whitespace between the elements is text the handler stacks, as in a real record (see the empty-document test above).
  const leaves = Array.from({ length: 10_001 }, (_, index) => `<e${index}>v</e${index}>`).join("\n");
  const { metadata } = await parseDirect(`<DIF>\n${leaves}\n</DIF>`);
  const keys = metadata.names().filter((key) => key.startsWith("dif:"));
  assert.equal(keys.length, 10_000);
  assert.ok(keys.includes("dif:DIF-e9999"));
  assert.ok(!keys.includes("dif:DIF-e10000"));
});

test("the nesting cap is inclusive: maxDepth elements open at once are read, one more is a limit", async () => {
  const parser = new DifParser({ maxDepth: 3 });
  const { metadata } = await parseDirect("<a>\n<b>\n<c>x</c>\n</b>\n</a>", parser);
  assert.deepEqual(metadata.getAll("dif:a-b-c"), ["x"]);
  await assert.rejects(parseDirect("<a>\n<b>\n<c>\n<d>x</d>\n</c>\n</b>\n</a>", parser), (error: Error) => error.name === "LimitExceededError");
});
