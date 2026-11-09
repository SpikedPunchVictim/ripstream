import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";
import { zip, type ZipFixtureEntry } from "./zip-fixture.ts";

/*
 * Detection reads untrusted bytes, so the work it does on a package must stay bounded. Both packages here are docx
 * files whose [Content_Types].xml names an xlsx main part (/other.xml) first. When the package opens, the answer is the
 * docx its relationship names; when it is refused, Tika falls back to the content-type scan and the xlsx wins. The
 * assertions below therefore read "docx" as "opened" and "xlsx" as "refused".
 */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOCX_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const XLSX_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const RELATIONSHIPS_TYPE = "application/vnd.openxmlformats-package.relationships+xml";
const OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

const detector = new DefaultDetector();

async function detect(bytes: Uint8Array, filename: string): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const metadata = new Metadata();
    metadata.set("resourceName", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

function packageOf(xmlContentType: string, parts: readonly ZipFixtureEntry[]): Uint8Array {
  const types =
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${TYPES_NAMESPACE}">` +
    `<Default Extension="rels" ContentType="${RELATIONSHIPS_TYPE}"/>` +
    `<Default Extension="xml" ContentType="${xmlContentType}"/>` +
    `<Override PartName="/other.xml" ContentType="${XLSX_MAIN}"/>` +
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MAIN}"/></Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">` +
    `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}" Target="word/document.xml"/></Relationships>`;
  return zip([
    { name: "[Content_Types].xml", data: types },
    { name: "_rels/.rels", data: rootRels },
    { name: "word/document.xml", data: "<x/>" },
    { name: "other.xml", data: "<x/>" },
    ...parts,
  ]);
}

async function assertAnswers(bytes: Uint8Array, expected: string): Promise<void> {
  assert.equal(await detect(bytes, "a.docx"), expected);
  assert.equal(await detect(bytes, "x.bin"), expected);
}

// Valid, well formed, and about 0.95 MiB each, but a few hundred bytes once deflated.
const PADDING = " ".repeat(1_000_000);
const PADDED_RELATIONSHIPS = deflateRawSync(
  Buffer.from(`<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">${PADDING}</Relationships>`),
);

function partWithRelationships(name: string, relationships: ZipFixtureEntry): ZipFixtureEntry[] {
  return [{ name: `${name}.xml`, data: "<x/>" }, relationships];
}

test("a package whose part relationships exceed the read budget is accepted without reading the rest", async () => {
  // 18 parts with valid relationships, then one whose relationships are malformed. Tika refuses the package at the
  // last one; reading all 19 would mean inflating about 18 MiB, so detection stops at its 16 MiB budget and accepts.
  const parts: ZipFixtureEntry[] = [];
  for (let index = 0; index < 18; index++) {
    parts.push(
      ...partWithRelationships(`p${index}`, { name: `_rels/p${index}.xml.rels`, deflated: PADDED_RELATIONSHIPS }),
    );
  }
  parts.push(...partWithRelationships("last", { name: "_rels/last.xml.rels", data: "<<<" }));

  await assertAnswers(packageOf("application/xml", parts), DOCX);
});

test("a malformed part relationships file is still refused while the budget lasts", async () => {
  const parts = [
    ...partWithRelationships("first", { name: "_rels/first.xml.rels", data: "<<<" }),
    ...partWithRelationships("p0", { name: "_rels/p0.xml.rels", deflated: PADDED_RELATIONSHIPS }),
  ];

  await assertAnswers(packageOf("application/xml", parts), XLSX);
});

test("a very long content type is validated once however many parts use it", async () => {
  // The Default for "xml" is a valid ~900 KB media type that every one of the 5000 parts uses. Validating it per part
  // would scan 4.5 GB; detection checks each distinct content type once.
  const contentType = `a${"b".repeat(900_000)}/c`;
  const parts: ZipFixtureEntry[] = [];
  for (let index = 0; index < 5000; index++) parts.push({ name: `p/${index}.xml`, data: "<x/>" });

  const started = performance.now();
  await assertAnswers(packageOf(contentType, parts), DOCX);
  const seconds = (performance.now() - started) / 1000;
  assert.ok(seconds < 2, `took ${seconds.toFixed(1)}s`);
});

function packageWith(typesXml: string, rootRels: string): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", data: typesXml },
    { name: "_rels/.rels", data: rootRels },
    { name: "word/document.xml", data: "<x/>" },
    { name: "other.xml", data: "<x/>" },
  ]);
}

const TYPES =
  `<Types xmlns="${TYPES_NAMESPACE}"><Default Extension="rels" ContentType="${RELATIONSHIPS_TYPE}"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/other.xml" ContentType="${XLSX_MAIN}"/>` +
  `<Override PartName="/word/document.xml" ContentType="${DOCX_MAIN}"/>`;
const ROOT_RELS =
  `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">` +
  `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}" Target="word/document.xml"/>`;

async function assertWithin(seconds: number, bytes: Uint8Array, expected: string): Promise<void> {
  const started = performance.now();
  await assertAnswers(bytes, expected);
  const took = (performance.now() - started) / 1000;
  assert.ok(took < seconds, `took ${took.toFixed(1)}s`);
}

// saxes in namespace mode walks every open element to look a prefix up, so 60,000 nested elements took 21 s there;
// Java parses the same package at once and opens it (measured). The namespaces are resolved by a per-prefix stack.
test("nesting depth costs time in proportion to size", async () => {
  const depth = 60_000;
  const nested = `${"<a>".repeat(depth)}${"</a>".repeat(depth)}`;
  await assertWithin(2, packageWith(`${TYPES}</Types>`, `${ROOT_RELS}${nested}</Relationships>`), DOCX);
  await assertWithin(2, packageWith(`${TYPES}${nested}</Types>`, `${ROOT_RELS}</Relationships>`), DOCX);
});

test("a prefix declared on every nested element costs time in proportion to size", async () => {
  const depth = 20_000;
  let open = "";
  let close = "";
  for (let index = 0; index < depth; index++) {
    open += `<a xmlns:p${index}="http://example.com/${index}" p${index}:k="v">`;
    close += "</a>";
  }
  await assertWithin(2, packageWith(`${TYPES}</Types>`, `${ROOT_RELS}${open}${close}</Relationships>`), DOCX);
});

// Tika opens a package whose [Content_Types].xml is 40 MiB (measured); a part is read up to a bound.
test("a content types part is read up to the 16 MiB bound", async () => {
  const padding = (mebibytes: number): string => `<!-- ${"x".repeat(mebibytes * 1024 * 1024)} -->`;
  await assertAnswers(packageWith(`${TYPES}${padding(12)}</Types>`, `${ROOT_RELS}</Relationships>`), DOCX);
});

test("a content types part past the bound is not read (a known deviation: Tika opens it)", async () => {
  const bytes = packageWith(`${TYPES}<!-- ${"x".repeat(17 * 1024 * 1024)} -->`.concat("</Types>"), `${ROOT_RELS}</Relationships>`);
  // Neither the package nor the content-type scan is reached, so the zip is only recognised as OOXML.
  assert.equal(await detect(bytes, "x.bin"), "application/x-tika-ooxml");
});
