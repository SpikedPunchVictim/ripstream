import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";
import { ZipArchive } from "../src/containers/zip-archive.ts";
import { zip } from "./zip-fixture.ts";

/*
 * A small input is read from memory, with no temp file made for it (RipstreamInputStream.openReader); a larger one is read
 * from its file. The two must give the same answer for every container, the hostile ones included.
 */

const ODF = zip([
  { name: "mimetype", data: "application/vnd.oasis.opendocument.text" },
  { name: "content.xml", data: "<office:document-content/>" },
]);
const JAR = zip([{ name: "META-INF/MANIFEST.MF" }, { name: "a/B.class" }]);
const PLAIN = zip([{ name: "readme.txt" }]);

async function detect(bytes: Uint8Array, spoolThreshold: number): Promise<{ type: string; file: boolean }> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold });
  try {
    const metadata = new Metadata();
    metadata.set("tk:resource-name", "x.bin");
    const type = (await new DefaultDetector().detect(stream, metadata, new ParseContext())).toString();
    return { type, file: stream.hasFile };
  } finally {
    await stream.close();
  }
}

test("a small zip is detected from memory and a spilled one from its file, to the same type", async () => {
  for (const [bytes, expected] of [
    [ODF, "application/vnd.oasis.opendocument.text"],
    [JAR, "application/java-archive"],
    [PLAIN, "application/zip"],
  ] as const) {
    const memory = await detect(bytes, 1024 * 1024);
    const file = await detect(bytes, 0);
    assert.deepEqual(memory, { type: expected, file: false });
    assert.deepEqual(file, { type: expected, file: true });
  }
});

test("two inputs never see each other's archive", async () => {
  const first = await detect(ODF, 1024 * 1024);
  const second = await detect(JAR, 1024 * 1024);
  const firstAgain = await detect(ODF, 1024 * 1024);
  assert.equal(first.type, "application/vnd.oasis.opendocument.text");
  assert.equal(second.type, "application/java-archive");
  assert.equal(firstAgain.type, first.type);
});

test("a central directory offset past 2^53 reads as not a zip, from memory as from a file", async () => {
  // Zip64 end record locator (20 bytes) naming a record at 2^60, then an end record that defers to it.
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, 2n ** 60n, true);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(10, 0xffff, true);
  const hostile = new Uint8Array([...zip([{ name: "a.txt" }]).subarray(0, 40), ...locator, ...end]);
  const memory = await detect(hostile, 1024 * 1024);
  const file = await detect(hostile, 0);
  assert.equal(memory.type, file.type);
  assert.equal(memory.type, "application/zip");
});

test("ZipArchive.from closes the reader of an input that is not a zip", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("not a zip at all, just text, no central directory"));
  const reader = await stream.openReader();
  let closed = false;
  const close = reader.close.bind(reader);
  reader.close = async () => {
    closed = true;
    await close();
  };
  try {
    assert.equal(await ZipArchive.from(reader), null);
    assert.equal(closed, true);
  } finally {
    await stream.close();
  }
});
