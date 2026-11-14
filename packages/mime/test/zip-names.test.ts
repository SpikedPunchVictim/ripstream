import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";
import { ZipArchive } from "../src/containers/zip-archive.ts";
import { zip } from "./zip-fixture.ts";

/*
 * How a member's name is read from the central directory (tikajs-68os.26). Tika opens the container with commons-compress
 * `ZipFile` and no charset (DefaultZipContainerDetector.java:237 -> ZipFileHelper.open(tis, null)), and its streaming
 * path names "UTF8" outright (DefaultZipContainerDetector.java:305), so a name is UTF-8 whether or not general-purpose
 * bit 11 is set. What bit 11 changes is whether ZipFile honours an Info-ZIP Unicode Path extra field (0x7075): only for
 * a member whose bit 11 is clear, and only when the field's CRC32 is that of the name bytes in the header. The
 * ZipFile rule is commons-compress behaviour, not in the Tika tree: these tests pin ripstream's reading of it.
 */

const encoder = new TextEncoder();
const EFS_FLAG = 0x0800;
const ODF_TEXT = "application/vnd.oasis.opendocument.text";

/** An Info-ZIP Unicode Path extra field: id, size, version 1, CRC32 of the header name, the UTF-8 name. */
function unicodePath(headerName: Uint8Array, name: string, crc: number = crc32(headerName)): Uint8Array {
  const utf8 = encoder.encode(name);
  const field = new Uint8Array(4 + 5 + utf8.length);
  const view = new DataView(field.buffer);
  view.setUint16(0, 0x7075, true);
  view.setUint16(2, 5 + utf8.length, true);
  field[4] = 1;
  view.setUint32(5, crc >>> 0, true);
  field.set(utf8, 9);
  return field;
}

async function namesOf(bytes: Uint8Array): Promise<string[]> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const archive = await ZipArchive.open(await stream.getFile());
    assert.notEqual(archive, null, "the fixture has a readable central directory");
    try {
      return archive!.entries.map((entry) => entry.name);
    } finally {
      await archive!.close();
    }
  } finally {
    await stream.close();
  }
}

async function detect(bytes: Uint8Array): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const metadata = new Metadata();
    metadata.set("tk:resource-name", "x.bin");
    return (await new DefaultDetector().detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

test("a name is UTF-8 whether or not general-purpose bit 11 is set", async () => {
  const names = await namesOf(
    zip([
      { name: "日本語.txt" },
      { name: "café.txt", flags: EFS_FLAG },
    ]),
  );
  assert.deepEqual(names, ["日本語.txt", "café.txt"]);
});

test("a Unicode path field names a member whose bit 11 is clear, however the header bytes read", async () => {
  // The header bytes are a CP437 "é" (0x82), not UTF-8; the field carries the real name.
  const headerName = Uint8Array.of(0x82, 0x2e, 0x74, 0x78, 0x74);
  const names = await namesOf(zip([{ name: "", nameBytes: headerName, extra: unicodePath(headerName, "é.txt") }]));
  assert.deepEqual(names, ["é.txt"]);
});

test("a Unicode path field can name an entry a detector looks for exactly", async () => {
  const headerName = encoder.encode("plain.bin");
  const odf = zip([
    { name: "", nameBytes: headerName, extra: unicodePath(headerName, "mimetype"), data: ODF_TEXT },
    { name: "content.xml" },
  ]);
  assert.equal(await detect(odf), ODF_TEXT);
});

test("a Unicode path field is ignored when bit 11 is set", async () => {
  const headerName = encoder.encode("plain.bin");
  const names = await namesOf(zip([{ name: "", nameBytes: headerName, flags: EFS_FLAG, extra: unicodePath(headerName, "mimetype") }]));
  assert.deepEqual(names, ["plain.bin"]);
});

test("a Unicode path field is ignored when its CRC32 is not that of the header name", async () => {
  const headerName = encoder.encode("plain.bin");
  const names = await namesOf(
    zip([{ name: "", nameBytes: headerName, extra: unicodePath(headerName, "mimetype", crc32(headerName) ^ 1) }]),
  );
  assert.deepEqual(names, ["plain.bin"]);
});

test("a Unicode path field of another version or too short to hold a CRC is ignored", async () => {
  const headerName = encoder.encode("plain.bin");
  const wrongVersion = unicodePath(headerName, "mimetype");
  wrongVersion[4] = 2;
  const tooShort = Uint8Array.of(0x75, 0x70, 0x04, 0x00, 1, 0, 0, 0);
  for (const extra of [wrongVersion, tooShort]) {
    assert.deepEqual(await namesOf(zip([{ name: "", nameBytes: headerName, extra }])), ["plain.bin"]);
  }
});

test("other extra fields do not hide a Unicode path field", async () => {
  const headerName = encoder.encode("plain.bin");
  const other = Uint8Array.of(0x55, 0x54, 0x02, 0x00, 0xaa, 0xbb); // an extended-timestamp field with two data bytes
  const field = unicodePath(headerName, "mimetype");
  const extra = new Uint8Array(other.length + field.length);
  extra.set(other, 0);
  extra.set(field, other.length);
  assert.deepEqual(await namesOf(zip([{ name: "", nameBytes: headerName, extra }])), ["mimetype"]);
});

test("when a Unicode path field repeats, the last one decides, and a bad last one leaves the header name", async () => {
  const headerName = encoder.encode("plain.bin");
  const good = unicodePath(headerName, "first");
  const better = unicodePath(headerName, "second");
  const bad = unicodePath(headerName, "third", crc32(headerName) ^ 1);
  const join = (...fields: Uint8Array[]): Uint8Array => Uint8Array.from(fields.flatMap((field) => [...field]));
  assert.deepEqual(await namesOf(zip([{ name: "", nameBytes: headerName, extra: join(good, better) }])), ["second"]);
  assert.deepEqual(await namesOf(zip([{ name: "", nameBytes: headerName, extra: join(bad, good) }])), ["first"]);
  assert.deepEqual(await namesOf(zip([{ name: "", nameBytes: headerName, extra: join(good, bad) }])), ["plain.bin"]);
});

test("a ZIP64 local offset above 2^53 reads as an absent entry, not a raw RangeError from the file handle", async () => {
  const bytes = zip([{ name: "x", data: "hello", zip64: true }]);
  const view = new DataView(bytes.buffer);
  // The central entry starts after the one local entry; its ZIP64 extra's last field is the local offset.
  const central = bytes.byteLength - 22 - 46 - 1 - 28;
  assert.equal(view.getUint32(central, true), 0x02014b50);
  const extra = central + 46 + 1;
  assert.equal(view.getUint16(extra, true), 0x0001);
  view.setBigUint64(extra + 20, 2n ** 63n, true);
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const archive = await ZipArchive.open(await stream.getFile());
    assert.notEqual(archive, null);
    try {
      assert.equal(await archive!.read("x", 100), null);
    } finally {
      await archive!.close();
    }
  } finally {
    await stream.close();
  }
});
