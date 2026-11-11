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
