import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync, strToU8, zipSync } from "fflate";
import { createRipstream } from "../src/index.ts";

/*
 * Each ZIP based format that has its own parser (tikajs-68os.13), from the bytes of an archive built here through the
 * whole facade: detection, the parser the registry picks, and the embedded documents. The expectations are what Tika
 * 4.2.0's parsers do when read; none of this was run against a Tika.
 */

const ripstream = createRipstream();

function archive(entries: Record<string, string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) files[name] = typeof value === "string" ? strToU8(value) : value;
  return zipSync(files);
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

test("a GeoGebra file is detected, parsed by GeoGebraParser and its script is an embedded document", async () => {
  const records = await ripstream.parseRecursive(
    archive({
      "geogebra.xml": `${XML_HEAD}<geogebra format="5.0" version="5.0.815.0" app="classic" id="abc"><construction/></geogebra>`,
      "geogebra_javascript.js": "function ggbOnInit() {}",
    }),
    { filename: "a.ggb", handlerType: "text" },
  );
  assert.equal(String(records[0]!.mediaType), "application/vnd.geogebra.file");
  assert.equal(records[0]!.metadata.get("tk:parsed-by"), "GeoGebraParser");
  assert.equal(records[0]!.metadata.get("geogebra:app-name"), "classic");
  assert.equal(records.length, 2);
  assert.equal(records[1]!.metadata.get("tk:embedded-resource-type"), "MACRO");
});

test("a GeoGebra slides file is detected from its structure.json and slide folders", async () => {
  const records = await ripstream.parseRecursive(
    archive({
      "structure.json": '{"elementIds":["_slide0"]}',
      "_slide0/geogebra.xml": `${XML_HEAD}<geogebra format="5.0" version="5.2.0.0" app="notes" id="s"><construction/></geogebra>`,
    }),
    { handlerType: "text" },
  );
  assert.equal(String(records[0]!.mediaType), "application/vnd.geogebra.slides");
  assert.equal(records[0]!.metadata.get("tk:parsed-by"), "GeoGebraParser");
  assert.equal(records[0]!.metadata.get("xmpTPg:NPages"), "1");
});

test("an IDML package is detected from its mimetype entry, and gives its text, page counts and XMP dates", async () => {
  const packaging = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"';
  const records = await ripstream.parseRecursive(
    archive({
      mimetype: "application/vnd.adobe.indesign-idml-package",
      "META-INF/metadata.xml":
        `${XML_HEAD}<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
        '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreateDate>2020-09-20T20:07:44Z</xmp:CreateDate>' +
        "<xmp:CreatorTool>Adobe InDesign</xmp:CreatorTool></rdf:Description></rdf:RDF></x:xmpmeta>",
      "Spreads/Spread_u1.xml": `${XML_HEAD}<idPkg:Spread ${packaging}><Spread PageCount="2"/></idPkg:Spread>`,
      "MasterSpreads/MasterSpread_u2.xml": `${XML_HEAD}<idPkg:MasterSpread ${packaging}><MasterSpread PageCount="1"/></idPkg:MasterSpread>`,
      "Stories/Story_u3.xml": `${XML_HEAD}<idPkg:Story ${packaging}><Story><Content>Hello</Content><Content>World</Content></Story></idPkg:Story>`,
    }),
    { handlerType: "text" },
  );
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(String(record!.mediaType), "application/vnd.adobe.indesign-idml-package");
  assert.equal(record!.metadata.get("tk:parsed-by"), "IDMLParser");
  assert.match(record!.content, /Hello\s+World/);
  assert.equal(record!.metadata.get("idml:spread-page-count"), "2");
  assert.equal(record!.metadata.get("idml:master-spread-page-count"), "1");
  assert.equal(record!.metadata.get("meta:page-count"), "3");
  assert.equal(record!.metadata.get("xmp:CreateDate"), "2020-09-20T20:07:44Z");
  assert.equal(record!.metadata.get("xmp:CreatorTool"), "Adobe InDesign");
});

test("a WACZ is detected, and each WARC under archive/ is an embedded application/warc, plain or gzip", async () => {
  const warc = "WARC/1.0\r\nWARC-Type: warcinfo\r\nContent-Length: 0\r\n\r\n\r\n\r\n";
  const records = await ripstream.parseRecursive(
    archive({
      "datapackage.json": '{"profile":"data-package"}',
      "archive/plain.warc": warc,
      "archive/zipped.warc.gz": gzipSync(strToU8(warc)),
    }),
    { handlerType: "text" },
  );
  assert.equal(String(records[0]!.mediaType), "application/x-wacz");
  assert.equal(records[0]!.metadata.get("tk:parsed-by"), "WACZParser");
  const types = records.slice(1).map((record) => String(record.mediaType));
  assert.deepEqual(types, ["application/warc", "application/warc"]);
  assert.deepEqual(
    records.slice(1).map((record) => record.metadata.get("tk:resource-name")),
    ["plain.warc", "zipped.warc.gz"],
  );
});

test("an XLZ is parsed by XLZParser, and the text and counts of its XLIFF 1.2 files are the document's", async () => {
  const xlf =
    `${XML_HEAD}<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">` +
    '<file original="a.txt" source-language="en" target-language="fr" datatype="plaintext"><body>' +
    '<trans-unit id="1"><source xml:lang="en">Hello</source><target xml:lang="fr">Bonjour</target></trans-unit>' +
    "</body></file></xliff>";
  const records = await ripstream.parseRecursive(archive({ "doc.xlf": xlf }), { filename: "a.xlz", handlerType: "text" });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.metadata.get("tk:parsed-by"), "XLZParser");
  // XLIFF12Parser sets the Content-Type of the document it is given, which is the one of the XLZ.
  assert.equal(records[0]!.metadata.get("Content-Type"), "application/x-xliff+xml");
  assert.match(records[0]!.content, /Hello/);
  assert.match(records[0]!.content, /Bonjour/);
  assert.equal(records[0]!.metadata.get("file-count"), "1");
  assert.equal(records[0]!.metadata.get("tu-count"), "1");
});

test("a hostile archive of each format is refused through the facade, not expanded", async () => {
  const limits = { maxEmbeddedResourceBytes: 1_000_000, maxTotalEmbeddedBytes: 4_000_000 };
  const strict = createRipstream({ limits });
  const bomb = new Uint8Array(5_000_000);
  const cases: Array<[string, Uint8Array, string?]> = [
    [
      "geogebra",
      archive({ "geogebra.xml": `<geogebra>${" ".repeat(5_000_000)}</geogebra>` }),
      "a.ggb",
    ],
    ["idml", archive({ mimetype: "application/vnd.adobe.indesign-idml-package", "Stories/Story_u1.xml": " ".repeat(5_000_000) })],
    ["wacz", archive({ "datapackage.json": "{}", "archive/a.warc": bomb })],
    ["xlz", archive({ "a.xlf": " ".repeat(5_000_000) }), "a.xlz"],
  ];
  for (const [label, bytes, filename] of cases) {
    const options = filename === undefined ? { handlerType: "text" as const } : { filename, handlerType: "text" as const };
    await assert.rejects(strict.parseRecursive(bytes, options), (error: Error) => {
      assert.match(error.name, /LimitExceeded/, label);
      return true;
    });
  }
});
