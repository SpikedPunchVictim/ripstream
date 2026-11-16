import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata } from "@spikedpunch/ripstream-core";
import {
  applyPropertySetMetadata,
  parsePropertySets,
} from "../src/property-sets.ts";
import { DOCUMENT_SUMMARY_ID } from "./property-set-builder.ts";

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

/*
 * A DocumentSummaryInformation stream with a user-defined section. The dictionary (property 0) has no type word, the entry
 * count is at its offset: the layout of testEXCEL_dateFormats.xls, whose custom properties Tika 4.2.0 names (tikajs-nb4y).
 */
function buildCustomProperties(): Uint8Array {
  const header = [
    ...u16(0xfffe),
    ...u16(0),
    ...new Array(20).fill(0),
    ...u32(2),
    ...DOCUMENT_SUMMARY_ID,
    ...u32(68),
    ...new Array(16).fill(0),
    ...u32(76),
  ];
  const empty = [...u32(8), ...u32(0)];

  const name = [...new TextEncoder().encode("Project"), 0];
  const text = [...new TextEncoder().encode("Atlas"), 0];
  const utf16 = text.flatMap((byte) => [byte, 0]);

  const section = [
    ...u32(80),
    ...u32(3),
    ...u32(1),
    ...u32(32),
    ...u32(0),
    ...u32(36),
    ...u32(2),
    ...u32(60),
    ...u16(2),
    ...u16(1252),
    ...u32(1),
    ...u32(2),
    ...u32(name.length),
    ...name,
    ...u32(0),
    ...u16(31),
    ...u16(0),
    ...u32(6),
    ...utf16,
  ];
  assert.equal(section.length, 80);
  return new Uint8Array([...header, ...empty, ...section]);
}

test("reads custom property dictionaries", () => {
  const sets = parsePropertySets(buildCustomProperties());
  assert.equal(sets.length, 2);
  assert.equal(sets[1]?.names.get(2), "Project");
  const metadata = new Metadata();
  applyPropertySetMetadata(metadata, sets);
  assert.equal(metadata.get("custom:Project"), "Atlas");
});
