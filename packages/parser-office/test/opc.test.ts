import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LimitExceededError,
  MalformedDocumentError,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { strToU8, zipSync } from "fflate";
import { OpcPackage } from "../src/opc.ts";

async function sample(): Promise<RipstreamInputStream> {
  return RipstreamInputStream.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8("<w:document>hello</w:document>"),
      "word/media/large.bin": new Uint8Array(1_000_000),
    }),
  );
}

test("reads requested OPC parts from the central directory", async () => {
  const stream = await sample();
  const context = new ParseContext();
  const pkg = await OpcPackage.open(stream, context.limits);
  try {
    assert.deepEqual(
      pkg.names.sort(),
      ["[Content_Types].xml", "word/document.xml", "word/media/large.bin"],
    );
    assert.equal(
      new TextDecoder().decode(await pkg.read("word/document.xml")),
      "<w:document>hello</w:document>",
    );
    await assert.rejects(pkg.read("missing.xml"), MalformedDocumentError);
  } finally {
    await pkg.close();
    await stream.close();
  }
});

test("enforces per-entry decompression ratio", async () => {
  const stream = await sample();
  const context = new ParseContext({ limits: { maxDecompressionRatio: 2 } });
  const pkg = await OpcPackage.open(stream, context.limits);
  try {
    await assert.rejects(pkg.read("word/media/large.bin"), LimitExceededError);
  } finally {
    await pkg.close();
    await stream.close();
  }
});

test("rejects non-ZIP input", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("nope"));
  await assert.rejects(
    OpcPackage.open(stream, new ParseContext().limits),
    MalformedDocumentError,
  );
  await stream.close();
});

test("lying uncompressed size cannot exceed the entry budget", async () => {
  const bytes = zipSync({ "word/bomb.bin": new Uint8Array(5_000_000) });
  // Patch declared uncompressed size to 100 in local and central headers.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(22, 100, true);
  for (let i = 0; i < bytes.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 100, true);
  }
  const stream = await RipstreamInputStream.from(bytes);
  const pkg = await OpcPackage.open(stream, {
    ...new ParseContext().limits,
    maxDecompressionRatio: 1_000_000,
    maxEmbeddedResourceBytes: 1_000_000,
  });
  try {
    await assert.rejects(pkg.read("word/bomb.bin"), LimitExceededError);
  } finally {
    await pkg.close();
    await stream.close();
  }
});

function le(bytes: number, value: number): number[] {
  return Array.from({ length: bytes }, (_, i) => Math.floor(value / 2 ** (8 * i)) % 256);
}

// tikajs-00bw: a ZIP64 extra block that declares more bytes than the extra field holds.
test("a ZIP64 extra block longer than its field is a malformed package, not a RangeError", async () => {
  const name = new TextEncoder().encode("[Content_Types].xml");
  const extra = [...le(2, 1), ...le(2, 32)];
  const local = [...le(4, 0x04034b50), ...le(2, 20), ...Array(22).fill(0), ...le(2, name.length), ...le(2, 0), ...name];
  const central = [
    ...le(4, 0x02014b50), ...le(2, 20), ...le(2, 20), ...Array(8).fill(0), ...le(4, 0), ...le(4, 0), ...le(4, 0xffffffff),
    ...le(2, name.length), ...le(2, extra.length), ...le(2, 0), ...le(2, 0), ...le(2, 0), ...le(4, 0), ...le(4, 0), ...name, ...extra,
  ];
  const end = [...le(4, 0x06054b50), ...le(2, 0), ...le(2, 0), ...le(2, 1), ...le(2, 1), ...le(4, central.length), ...le(4, local.length), ...le(2, 0)];
  const stream = await RipstreamInputStream.from(new Uint8Array([...local, ...central, ...end]));
  try {
    await assert.rejects(OpcPackage.open(stream, new ParseContext().limits), (error: unknown) => {
      return error instanceof MalformedDocumentError || error instanceof LimitExceededError;
    });
  } finally {
    await stream.close();
  }
});

// A small package is read from memory (no temp file); a hostile offset FileHandle.read refuses must fail as it does from a file.
async function openError(bytes: Uint8Array, spoolThreshold: number): Promise<{ failure: string; file: boolean }> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold });
  try {
    const failure = await OpcPackage.open(stream, new ParseContext().limits).then(
      async (pkg) => {
        await pkg.close();
        return "opened";
      },
      (error: unknown) => `${(error as Error).constructor.name}: ${(error as Error).message}`,
    );
    return { failure, file: stream.hasFile };
  } finally {
    await stream.close();
  }
}

test("a small package is read from memory, a larger one from its file, with the same parts", async () => {
  const bytes = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<d>x</d>") });
  for (const [spoolThreshold, file] of [[1024 * 1024, false], [0, true]] as const) {
    const stream = await RipstreamInputStream.from(bytes, { spoolThreshold });
    const pkg = await OpcPackage.open(stream, new ParseContext().limits);
    try {
      assert.equal(stream.hasFile, file);
      assert.deepEqual(pkg.names.sort(), ["[Content_Types].xml", "word/document.xml"]);
      assert.equal(new TextDecoder().decode(await pkg.read("word/document.xml")), "<d>x</d>");
    } finally {
      await pkg.close();
      await stream.close();
    }
  }
});

test("a zip64 record offset past 2^53 fails from memory exactly as it fails from a file", async () => {
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, 2n ** 60n, true);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(10, 0xffff, true);
  const hostile = new Uint8Array([...new Uint8Array(30), ...locator, ...end]);
  const memory = await openError(hostile, 1024 * 1024);
  const file = await openError(hostile, 0);
  assert.equal(memory.failure, file.failure);
  assert.match(memory.failure, /position/);
  assert.equal(file.file, true);
});

test("two packages never see each other's parts", async () => {
  const first = await RipstreamInputStream.from(zipSync({ "a.xml": strToU8("<a>first</a>") }));
  const second = await RipstreamInputStream.from(zipSync({ "a.xml": strToU8("<a>second</a>"), "b.xml": strToU8("<b/>") }));
  const limits = new ParseContext().limits;
  const one = await OpcPackage.open(first, limits);
  const two = await OpcPackage.open(second, limits);
  try {
    assert.equal(new TextDecoder().decode(await one.read("a.xml")), "<a>first</a>");
    assert.equal(new TextDecoder().decode(await two.read("a.xml")), "<a>second</a>");
    assert.equal(one.has("b.xml"), false);
    assert.equal(two.has("b.xml"), true);
  } finally {
    await one.close();
    await two.close();
    await first.close();
    await second.close();
  }
});
