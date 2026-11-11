import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AutoDetectParser,
  BodyContentHandler,
  CONTEXT_KEYS,
  EncryptedDocumentError,
  MediaType,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "@spikedpunch/ripstream-mime";
import { IWork13Parser } from "@spikedpunch/ripstream-parser-office";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * Registration of the Microsoft Office types the default parser list held no parser for (tikajs-68os.18): the BIFF2-4
 * worksheets and workspaces (Tika's OldExcelParser) and the internal OLE2 types OfficeParser claims; and of the iWork
 * 2013 and 2018 package types (tikajs-68os.19, Tika's IWork13PackageParser and IWork18PackageParser). The claims are read
 * from the Tika 4.2.0 source (OldExcelParser.SUPPORTED_TYPES, OfficeParser.SUPPORTED_TYPES, the two iWork parsers'
 * supportedTypes); none of this was run against a Tika, which is not available here.
 */

/** The parsers selectParsers picks for a type through the registry (aliases and supertypes), best match first. */
async function selected(type: string): Promise<{ name: string; kind: string }[]> {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow(type), new ParseContext());
  return matches.map((match) => ({ name: match.parser.name, kind: match.kind }));
}

/**
 * Parses with the type named in the metadata and no detection, as Tika's CompositeParser does when a caller sets
 * Content-Type: how a type no detector produces for the bytes at hand reaches its parser.
 */
async function parseAs(bytes: Uint8Array, type: string): Promise<{ text: string; metadata: Metadata }> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  metadata.set("Content-Type", type);
  try {
    await createDefaultParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

const OLD_EXCEL_TYPES = [
  "application/vnd.ms-excel.sheet.2",
  "application/vnd.ms-excel.sheet.3",
  "application/vnd.ms-excel.sheet.4",
  "application/vnd.ms-excel.workspace.3",
  "application/vnd.ms-excel.workspace.4",
];

test("each of the five BIFF2-4 Excel types reaches OldExcelParser exactly", async () => {
  for (const type of OLD_EXCEL_TYPES) {
    const [first] = await selected(type);
    assert.deepEqual(first, { name: "OldExcelParser", kind: "exact" }, type);
  }
});

test("application/vnd.ms-excel still reaches the OLE2 workbook parser, not OldExcelParser", async () => {
  const [first] = await selected("application/vnd.ms-excel");
  assert.deepEqual(first, { name: "ExcelParser", kind: "exact" });
});

test("a BIFF2 sheet forced as sheet.2 or workspace.3 is read by OldExcelParser", async () => {
  // BOF (BIFF2, a worksheet), then a LABEL cell with the text "Old sheet", then EOF.
  const text = [...new TextEncoder().encode("Old sheet")];
  const bytes = Uint8Array.from([
    0x09, 0x00, 0x04, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x04, 0x00, 0x08 + text.length, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, text.length, ...text,
    0x0a, 0x00, 0x00, 0x00,
  ]);
  for (const type of ["application/vnd.ms-excel.sheet.2", "application/vnd.ms-excel.workspace.3"]) {
    const result = await parseAs(bytes, type);
    assert.match(result.text, /Old sheet/, type);
    assert.equal(result.metadata.get("tk:parsed-by"), "OldExcelParser", type);
  }
});

const OLE_TYPES = [
  "application/x-tika-msoffice",
  "application/x-tika-msoffice-embedded; format=ole10_native",
  // Not in OfficeParser's list by name, but its base type is the embedded one's: a composite matches on base types.
  "application/x-tika-msoffice-embedded; format=comp_obj",
  "application/x-tika-ole-drm-encrypted",
  "application/x-tika-ooxml-protected",
  "application/sldworks",
];

test("each internal OLE2 type OfficeParser claims reaches it exactly", async () => {
  for (const type of OLE_TYPES) {
    const [first] = await selected(type);
    assert.deepEqual(first, { name: "OfficeParser", kind: "exact" }, type);
  }
});

test("an OLE2 container forced as the generic, embedded or SolidWorks type is read for its metadata only", async () => {
  const bytes = readFileSync(new URL("./fixtures/office-old/testEXCEL_5.xls", import.meta.url));
  for (const type of [
    "application/x-tika-msoffice",
    "application/x-tika-msoffice-embedded; format=ole10_native",
    "application/sldworks",
  ]) {
    const result = await parseAs(bytes, type);
    assert.equal(result.text.trim(), "", type);
    assert.equal(result.metadata.get("tk:parsed-by"), "OfficeParser", type);
  }
});

test("the DRM and password-protected OOXML types are refused as encrypted", async () => {
  const bytes = readFileSync(new URL("./fixtures/office-old/testEXCEL_5.xls", import.meta.url));
  for (const type of ["application/x-tika-ole-drm-encrypted", "application/x-tika-ooxml-protected"]) {
    await assert.rejects(parseAs(bytes, type), EncryptedDocumentError, type);
  }
});

const IWORK_13_TYPES = [
  "application/vnd.apple.keynote.13",
  "application/vnd.apple.numbers.13",
  "application/vnd.apple.pages.13",
  "application/vnd.apple.unknown.13",
];
const IWORK_18_TYPES = [
  "application/vnd.apple.keynote.18",
  "application/vnd.apple.numbers.18",
  "application/vnd.apple.pages.18",
];

test("each iWork 2013 type reaches IWork13PackageParser exactly, each 2018 type IWork18PackageParser", async () => {
  for (const type of IWORK_13_TYPES) {
    const [first] = await selected(type);
    assert.deepEqual(first, { name: "IWork13PackageParser", kind: "exact" }, type);
  }
  for (const type of IWORK_18_TYPES) {
    const [first] = await selected(type);
    assert.deepEqual(first, { name: "IWork18PackageParser", kind: "exact" }, type);
  }
});

test("the iWork '09 types still reach IWorkPackageParser, which the 2013 parser no longer claims", async () => {
  for (const type of ["application/vnd.apple.keynote", "application/vnd.apple.numbers", "application/vnd.apple.pages"]) {
    const matches = await selected(type);
    assert.deepEqual(matches[0], { name: "IWorkPackageParser", kind: "exact" }, type);
    assert.ok(!matches.some((match) => match.name === "IWork13PackageParser"), type);
  }
});

const ripstream = createRipstream();

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/iwork/${name}`, import.meta.url)));
}

/** Calls one parser directly, with an auto-detecting parser for the embedded documents, as IWork13ParserTest does. */
async function callDirectly(parser: Parser, bytes: Uint8Array): Promise<{ text: string; metadata: Metadata }> {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, new AutoDetectParser({ detector: new DefaultDetector(), parser: createDefaultParser() }));
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await parser.parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("IWork13ParserTest.testParseKeynote13: called directly, the Keynote package has nine metadata entries and its type", async () => {
  const { metadata } = await callDirectly(new IWork13Parser(), fixture("testKeynote2013.key"));
  assert.equal(metadata.size(), 9);
  assert.equal(metadata.get("Content-Type"), "application/vnd.apple.keynote.13");
});

test("IWork13ParserTest.testParseNumbers13 and testParsePages13: unknown type, and the thumbnail's name as the only text", async () => {
  for (const name of ["testNumbers2013.numbers", "testPages2013.pages"]) {
    const { text, metadata } = await callDirectly(new IWork13Parser(), fixture(name));
    assert.equal(metadata.get("Content-Type"), "application/vnd.apple.unknown.13", name);
    assert.equal(text.trim(), "preview.jpg", name);
  }
});

test("IWork13ParserTest.testNumbers13WFileName: with the file name, two records, the second the JPEG thumbnail", async () => {
  const records = await ripstream.parseRecursive(fixture("testNumbers2013.numbers"), { filename: "testNumbers2013.numbers" });
  assert.equal(records.length, 2);
  assert.equal(records[0]!.metadata.get("Content-Type"), "application/vnd.apple.numbers.13");
  assert.equal(records[0]!.metadata.get("iwork:isMultiPage"), "true");
  assert.equal(records[0]!.metadata.get("iwork:versionUUID"), "C5ED6463-575C-43B9-8FDA-1957B186C422");
  assert.equal(records[1]!.metadata.get("Content-Type"), "image/jpeg");
  assert.equal(records[1]!.metadata.get("tk:embedded-resource-type"), "THUMBNAIL");
});

/** The 2018 fixture holds no preview, so, as IWork18ParserTest does, a copy of it gets one. */
function keynote2018WithPreview(): Uint8Array {
  const preview = unzipSync(fixture("testKeynote2013.key"))["preview-micro.jpg"]!;
  const entries: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(unzipSync(fixture("testKeynote2018.key")))) {
    if (!name.endsWith("/")) entries[name] = data;
  }
  entries["Presentation.key/preview.jpg"] = preview;
  return zipSync(entries);
}

test("IWork18ParserTest.testNoPreview: the 2018 Keynote is typed, and no embedded document is emitted", async () => {
  const records = await ripstream.parseRecursive(fixture("testKeynote2018.key"), { filename: "testKeynote2018.key" });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.metadata.get("Content-Type"), "application/vnd.apple.keynote.18");
});

test("IWork18ParserTest.testPreviewIsTheThumbnail: a preview.jpg in the package directory is the second record", async () => {
  const records = await ripstream.parseRecursive(keynote2018WithPreview(), { filename: "testKeynote2018.key" });
  assert.equal(records.length, 2);
  assert.equal(records[0]!.metadata.get("Content-Type"), "application/vnd.apple.keynote.18");
  assert.equal(records[1]!.metadata.get("tk:resource-name"), "Presentation.key/preview.jpg");
  assert.equal(records[1]!.metadata.get("tk:embedded-resource-type"), "THUMBNAIL");
  assert.equal(records[1]!.mediaType.toString(), "image/jpeg");
});
