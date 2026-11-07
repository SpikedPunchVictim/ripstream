import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { ExecutableParser, JavaClassParser, ScienceMetadataParser } from "../src/index.ts";

/** Every prefix of a valid file must parse or fail with MalformedDocumentError. */
async function assertPrefixesSafe(parser: Parser, full: Uint8Array, label: string): Promise<void> {
  for (let length = 0; length <= full.length; length++) {
    const stream = await RipstreamInputStream.from(full.slice(0, length));
    try {
      await parser.parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext());
    } catch (error) {
      assert.ok(
        error instanceof MalformedDocumentError,
        `${label} prefix ${length}: ${error instanceof Error ? error.constructor.name : error}`,
      );
    } finally {
      await stream.close();
    }
  }
}

function javaClass(): Uint8Array {
  const bytes: number[] = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 5];
  const utf8 = (value: string): number[] => [1, 0, value.length, ...new TextEncoder().encode(value)];
  bytes.push(...utf8("Hello"), 7, 0, 1, ...utf8("java/lang/Object"), 7, 0, 3);
  bytes.push(0, 0x21, 0, 2, 0, 4, 0, 0, 0, 0);
  bytes.push(0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 2, 0, 0);
  return new Uint8Array(bytes);
}

test("executable: truncated headers raise MalformedDocumentError", async () => {
  const pe = new Uint8Array(0x60);
  pe.set([0x4d, 0x5a], 0);
  new DataView(pe.buffer).setUint32(0x3c, 0x40, true);
  pe.set([0x50, 0x45, 0, 0], 0x40);
  const macho = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
  for (const [bytes, label] of [[pe, "pe"], [macho, "macho"]] as const) {
    await assertPrefixesSafe(new ExecutableParser(), bytes, label);
  }
});

test("java class: truncated files raise MalformedDocumentError", async () => {
  await assertPrefixesSafe(new JavaClassParser(), javaClass(), "class");
});

test("science: truncated MATLAB and NetCDF headers raise MalformedDocumentError", async () => {
  const mat = new Uint8Array(128);
  mat.set(new TextEncoder().encode("MATLAB 5.0 MAT-file"), 0);
  const netcdf = new Uint8Array(8);
  netcdf.set([0x43, 0x44, 0x46, 1], 0);
  await assertPrefixesSafe(new ScienceMetadataParser(), mat, "mat");
  await assertPrefixesSafe(new ScienceMetadataParser(), netcdf, "netcdf");
});
