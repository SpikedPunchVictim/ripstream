import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { detectZipContainer } from "../src/containers/zip.ts";
import {
  detectOle2Container,
  detectOle2Names,
} from "../src/containers/ole2.ts";

const encoder = new TextEncoder();

function zip(
  entries: Array<{ name: string; data?: string; deflated?: Uint8Array }>,
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.deflated ?? encoder.encode(entry.data ?? "x");
    const method = entry.deflated === undefined ? 0 : 8;
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const total = centralOffset + centralSize + 22;
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const local of locals) {
    result.set(local, cursor);
    cursor += local.length;
  }
  for (const central of centrals) {
    result.set(central, cursor);
    cursor += central.length;
  }
  const end = new DataView(result.buffer, cursor, 22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);
  return result;
}

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

test("OOXML refinement", async () => {
  assert.equal(
    (
      await detect(
        zip([{ name: "[Content_Types].xml" }, { name: "word/document.xml" }]),
      )
    )?.toString(),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(
    (
      await detect(
        zip([{ name: "[Content_Types].xml" }, { name: "xl/workbook.xml" }]),
      )
    )?.toString(),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(
    (
      await detect(
        zip([{ name: "[Content_Types].xml" }, { name: "ppt/presentation.xml" }]),
      )
    )?.toString(),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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

test("JAR, APK, iWork, and encrypted OOXML", async () => {
  assert.equal(
    (await detect(zip([{ name: "META-INF/MANIFEST.MF" }])))?.toString(),
    "application/java-archive",
  );
  assert.equal(
    (
      await detect(
        zip([{ name: "AndroidManifest.xml" }, { name: "classes.dex" }]),
      )
    )?.toString(),
    "application/vnd.android.package-archive",
  );
  assert.equal(
    (await detect(zip([{ name: "Index/Document.iwa" }])))?.toString(),
    "application/vnd.apple.iwork",
  );
});

test("the central directory walk is bounded: many entries, or a huge directory, are not walked", async () => {
  const marker = [{ name: "[Content_Types].xml" }, { name: "word/document.xml" }];
  const filler = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `f${index}` }));
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  // At the entry limit the walk still refines the type...
  assert.equal((await detect(zip([...marker, ...filler(9_998)])))?.toString(), docx);
  // ...one past it gives up (null: the caller falls back to the PK signature) rather than walking on.
  assert.equal(await detect(zip([...marker, ...filler(9_999)])), null);

  // A directory of few entries with enormous names is just as much work.
  const longName = "n".repeat(60_000);
  const heavy = Array.from({ length: 150 }, (_, index) => ({ name: `${index}${longName}` }));
  assert.equal(await detect(zip(heavy)), null);
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
