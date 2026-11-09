import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { detectZipContainer } from "../src/containers/zip.ts";
import { zip } from "./zip-fixture.ts";
import {
  detectOle2Container,
  detectOle2Names,
} from "../src/containers/ole2.ts";

const encoder = new TextEncoder();

async function detect(bytes: Uint8Array) {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    return await detectZipContainer(stream);
  } finally {
    await stream.close();
  }
}

test("plain zip", async () => {
  assert.equal((await detect(zip([{ name: "a.txt" }])))?.toString(), "application/zip");
});

const CONTENT_TYPES = (main: string): string =>
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/${main.split("|")[0]}" ContentType="${main.split("|")[1]}"/></Types>`;
const RELS = (target: string): string =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

function opc(part: string, contentType: string, zip64 = false) {
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES(`${part}|${contentType}`), zip64 },
    { name: "_rels/.rels", data: RELS(part), zip64 },
    { name: part, zip64 },
  ]);
}

test("OOXML refinement reads the main part's content type", async () => {
  const cases: Array<[string, string, string]> = [
    ["word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["word/document.xml", "application/vnd.ms-word.document.macroEnabled.main+xml", "application/vnd.ms-word.document.macroenabled.12"],
    ["xl/workbook.xml", "application/vnd.ms-excel.addin.macroEnabled.main+xml", "application/vnd.ms-excel.addin.macroenabled.12"],
    ["visio/document.xml", "application/vnd.ms-visio.drawing.main+xml", "application/vnd.ms-visio.drawing"],
  ];
  for (const [part, contentType, expected] of cases) {
    assert.equal((await detect(opc(part, contentType)))?.toString(), expected, contentType);
  }
});

test("members written with ZIP64 central entries are read (streaming writers such as 3MF's)", async () => {
  assert.equal(
    (await detect(opc("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", true)))?.toString(),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});

test("a package with no recognisable main part stays a plain zip", async () => {
  assert.equal(
    (await detect(zip([{ name: "[Content_Types].xml" }, { name: "word/document.xml" }])))?.toString(),
    "application/zip",
  );
});

test("ODF and EPUB mimetype entries", async () => {
  assert.equal(
    (
      await detect(
        zip([
          { name: "mimetype", data: "application/vnd.oasis.opendocument.text" },
          { name: "content.xml" },
        ]),
      )
    )?.toString(),
    "application/vnd.oasis.opendocument.text",
  );
  assert.equal(
    (
      await detect(
        zip([{ name: "mimetype", data: "application/epub+zip" }, { name: "OEBPS/x.html" }]),
      )
    )?.toString(),
    "application/epub+zip",
  );
});

test("deflated mimetype entry is read", async () => {
  const deflated = deflateRawSync(encoder.encode("application/epub+zip"));
  assert.equal(
    (await detect(zip([{ name: "mimetype", deflated }])))?.toString(),
    "application/epub+zip",
  );
});

test("deflate-bomb mimetype entry is ignored without inflating it", async () => {
  // Starts with a valid mimetype so an unbounded inflate would match EPUB.
  const bomb = new Uint8Array(2 * 1024 * 1024).fill(0x20);
  bomb.set(encoder.encode("application/epub+zip"));
  const deflated = deflateRawSync(bomb, { level: 9 });
  assert.ok(deflated.length < 4096);
  assert.equal(
    (await detect(zip([{ name: "mimetype", deflated }])))?.toString(),
    "application/zip",
  );
});

test("JAR, APK and iWork", async () => {
  assert.equal(
    (await detect(zip([{ name: "META-INF/MANIFEST.MF" }])))?.toString(),
    "application/java-archive",
  );
  assert.equal(
    (await detect(zip([{ name: "AndroidManifest.xml" }, { name: "classes.dex" }])))?.toString(),
    "application/vnd.android.package-archive",
  );
  // Tika needs iWork's build-version marker; a bare `Index/` directory is not an iWork package.
  assert.equal(
    (await detect(zip([{ name: "Index/Document.iwa" }])))?.toString(),
    "application/zip",
  );
  assert.equal(
    (await detect(zip([{ name: "Metadata/BuildVersionHistory.plist" }, { name: "Index/Slide.iwa" }])))?.toString(),
    "application/vnd.apple.keynote.13",
  );
});

test("an iWork 2009 index is identified from its root element without inflating all of it", async () => {
  // Real indexes run to tens of MB; the root element is at the front.
  const root = '<sl:document xmlns:sl="http://developer.apple.com/namespaces/sl">';
  const index = encoder.encode(root + " ".repeat(40 * 1024 * 1024));
  const deflated = deflateRawSync(index, { level: 9 });
  assert.ok(deflated.length < 100 * 1024);
  assert.equal(
    (
      await detect(
        zip([{ name: "buildVersionHistory.plist" }, { name: "index.xml", deflated }]),
      )
    )?.toString(),
    "application/vnd.apple.pages",
  );
});

test("the central directory walk is bounded: many entries, or a huge directory, are not walked", async () => {
  const marker = [{ name: "mimetype", data: "application/epub+zip" }];
  const filler = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `f${index}` }));

  // At the entry limit the walk still refines the type...
  assert.equal((await detect(zip([...marker, ...filler(9_999)])))?.toString(), "application/epub+zip");
  // ...one past it gives up (null: the caller falls back to the PK signature) rather than walking on.
  assert.equal(await detect(zip([...marker, ...filler(10_000)])), null);

  // A directory of few entries with enormous names is just as much work.
  const longName = "n".repeat(60_000);
  const heavy = Array.from({ length: 150 }, (_, index) => ({ name: `${index}${longName}` }));
  assert.equal(await detect(zip(heavy)), null);
});

test("a hostile or truncated container reads as not a container instead of throwing", async () => {
  const sig = (...bytes: number[]) => Uint8Array.from(bytes);
  const local = sig(0x50, 0x4b, 3, 4);
  // EOCD signature with fewer than 22 bytes after it.
  assert.equal(await detect(Uint8Array.from([...local, ...new Array(30).fill(0), 0x50, 0x4b, 5, 6, 0, 0, 0, 0])), null);

  // ZIP64 locator and record pointing at 2^64-1, and a ZIP64 extra field with the same offset.
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(10, 0xffff, true);
  eocdView.setUint32(16, 0xffffffff, true);
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, 0xffffffffffffffffn, true);
  assert.equal(await detect(Uint8Array.from([...local, ...new Array(60).fill(0), ...locator, ...eocd])), null);

  const valid = zip([{ name: "mimetype", data: "application/epub+zip", zip64: true }]);
  const extraOffset = valid.length - 22 - (4 + 24) + 4 + 16; // the central entry's local-offset slot
  new DataView(valid.buffer).setBigUint64(extraOffset, 0xffffffffffffffffn, true);
  assert.equal((await detect(valid))?.toString(), "application/zip");
});

test("a directory that ends before its declared entry count is not read as a partial name list", async () => {
  const bytes = zip([{ name: "mimetype", data: "application/epub+zip" }]);
  // The end record claims two entries; only one exists.
  new DataView(bytes.buffer).setUint16(bytes.length - 22 + 10, 2, true);
  assert.equal(await detect(bytes), null);
});

test("non-zip returns null", async () => {
  assert.equal(await detect(encoder.encode("not a zip")), null);
});

test("OLE2 name decision table", () => {
  assert.equal(detectOle2Names(["WordDocument"]).toString(), "application/msword");
  assert.equal(detectOle2Names(["Workbook"]).toString(), "application/vnd.ms-excel");
  assert.equal(detectOle2Names(["Book"]).toString(), "application/vnd.ms-excel");
  assert.equal(detectOle2Names(["PowerPoint Document"]).toString(), "application/vnd.ms-powerpoint");
  assert.equal(detectOle2Names(["__properties_version1.0"]).toString(), "application/vnd.ms-outlook");
  assert.equal(detectOle2Names(["VisioDocument"]).toString(), "application/vnd.visio");
  assert.equal(detectOle2Names(["EncryptedPackage"]).toString(), "application/x-tika-ooxml");
  assert.equal(detectOle2Names(["Other"]).toString(), "application/x-tika-msoffice");
});

test("OLE2 header and directory parsing", async () => {
  const sectorSize = 512;
  const bytes = new Uint8Array(512 + sectorSize + sectorSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(30, 9, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 0, true);
  view.setUint32(76, 1, true);

  // FAT sector 1: directory sector terminates, FAT terminates.
  const fatOffset = 512 + sectorSize;
  view.setUint32(fatOffset, 0xfffffffe, true);
  view.setUint32(fatOffset + 4, 0xfffffffe, true);

  // Directory sector 0, entry 0: "Workbook".
  const name = "Workbook";
  const directoryOffset = 512;
  for (let index = 0; index < name.length; index++) {
    view.setUint16(directoryOffset + index * 2, name.charCodeAt(index), true);
  }
  view.setUint16(directoryOffset + 64, (name.length + 1) * 2, true);
  view.setUint8(directoryOffset + 66, 5);

  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 128 });
  try {
    assert.equal((await detectOle2Container(stream))?.toString(), "application/vnd.ms-excel");
  } finally {
    await stream.close();
  }
});

function ole2Header(sectorShift: number, numDifat: number, firstDifat: number): Uint8Array {
  const bytes = new Uint8Array(512 + 512);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(30, sectorShift, true);
  view.setUint32(44, 1000, true);
  view.setUint32(48, 0xfffffffe, true);
  view.setUint32(68, firstDifat, true);
  view.setUint32(72, numDifat, true);
  for (let index = 0; index < 109; index++) view.setUint32(76 + index * 4, 0xffffffff, true);
  return bytes;
}

async function detectOle2Bytes(bytes: Uint8Array): Promise<unknown> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 128 });
  try {
    return await detectOle2Container(stream);
  } finally {
    await stream.close();
  }
}

// Detection is best-effort: a malformed OLE2 header must terminate (no hang) and return
// null so the detector falls through to magic/XML/text, rather than throwing at detect
// time and defeating the fallback chain. Parsers surface the malformation later at parse.
test("OLE2 DIFAT self-loop terminates and falls back (returns null, no hang)", async () => {
  const bytes = ole2Header(9, 2, 0);
  bytes.fill(0xff, 512, 1024);
  new DataView(bytes.buffer).setUint32(1020, 0, true);
  assert.equal(await detectOle2Bytes(bytes), null);
});

test("OLE2 oversize DIFAT count and bad sector shift fall back (return null)", async () => {
  assert.equal(await detectOle2Bytes(ole2Header(9, 0xffffffff, 0)), null);
  assert.equal(await detectOle2Bytes(ole2Header(31, 0, 0xfffffffe)), null);
  assert.equal(await detectOle2Bytes(ole2Header(30, 0, 0xfffffffe)), null);
});
