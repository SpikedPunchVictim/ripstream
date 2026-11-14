import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  LimitExceededError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { IccParser, JavaClassParser } from "../src/index.ts";
import { formatCell } from "../src/sas-format.ts";
import type { SasColumn } from "../src/sas7bdat.ts";

async function run(parser: IccParser | JavaClassParser, bytes: Uint8Array): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(bytes);
  const metadata = new Metadata();
  try {
    await parser.parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

const numeric: SasColumn = { name: "x", label: "", type: "numeric", offset: 0, width: 8, format: null };

test("sas: a double too large for toFixed is rounded to fifteen significant digits (tikajs-gz44)", () => {
  assert.equal(formatCell(numeric, 1.2345678901234567e19), "1.23456789012346E19");
  assert.equal(formatCell(numeric, 1.7976931348623157e308), "1.7976931348623157E308");
});

/** An ICC profile with one `desc` tag holding an `mluc` record whose declared string length and position are as given. */
function mlucProfile(length: number, position: number): Uint8Array {
  const tagOffset = 144;
  const data = new Uint8Array(tagOffset + 40);
  const view = new DataView(data.buffer);
  view.setUint32(0, data.length);
  view.setUint32(128, 1);
  data.set([0x64, 0x65, 0x73, 0x63], 132);
  view.setUint32(136, tagOffset);
  view.setUint32(140, 40);
  data.set([0x6d, 0x6c, 0x75, 0x63], tagOffset);
  view.setUint32(tagOffset + 8, 1);
  view.setUint32(tagOffset + 20, length);
  view.setUint32(tagOffset + 24, position);
  return data;
}

test("icc: an mluc string that claims to be 4 GiB is read only as far as the tag goes (tikajs-gz44)", async () => {
  const metadata = await run(new IccParser(), mlucProfile(0xfffffff0, 28));
  assert.notEqual(metadata.get("icc:version"), null);
});

test("icc: an mluc string positioned past the profile does not throw a RangeError (tikajs-gz44)", async () => {
  const metadata = await run(new IccParser(), mlucProfile(8, 0xfffffff0));
  assert.notEqual(metadata.get("icc:version"), null);
});

/** A class file with `methods` methods that all name the same utf8 constant of `nameChars` characters. */
function classWithSharedMethodName(methods: number, nameChars: number): Uint8Array {
  const bytes: number[] = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 5];
  const utf8 = (value: string): number[] => [1, (value.length >> 8) & 0xff, value.length & 0xff, ...new TextEncoder().encode(value)];
  bytes.push(...utf8("a".repeat(nameChars)), 7, 0, 1, ...utf8("java/lang/Object"), 7, 0, 3);
  bytes.push(0, 0x21, 0, 2, 0, 4, 0, 0, 0, 0);
  bytes.push((methods >> 8) & 0xff, methods & 0xff);
  for (let index = 0; index < methods; index++) bytes.push(0, 1, 0, 1, 0, 1, 0, 0);
  bytes.push(0, 0);
  return new Uint8Array(bytes);
}

test("java class: method names that outgrow the file many times over end in a limit error, not a RangeError (tikajs-gz44)", async () => {
  // 30,000 methods x 2 x 60,000 characters is 3.6 billion characters from a 300 KB file.
  await assert.rejects(run(new JavaClassParser(), classWithSharedMethodName(30_000, 60_000)), LimitExceededError);
});
