import { MalformedDocumentError, type Metadata } from "@spikedpunch/ripstream-core";
import type { CompoundFile } from "./cfb.ts";

const SUMMARY_STREAMS = ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"];

const SUMMARY_INFORMATION = "F29F85E0-4FF9-1068-AB91-08002B27B3D9";
const DOCUMENT_SUMMARY_INFORMATION = "D5CDD502-2E9C-101B-9397-08002B2CF9AE";
/** The user-defined section's id; POI's DocumentSummaryInformation also takes a stream whose first section has it. */
const USER_DEFINED_PROPERTIES = "D5CDD505-2E9C-101B-9397-08002B2CF9AE";

const VT_I2 = 2;
const VT_I4 = 3;
const VT_R4 = 4;
const VT_R8 = 5;
const VT_BSTR = 8;
const VT_BOOL = 11;
const VT_UI2 = 18;
const VT_UI4 = 19;
const VT_I8 = 20;
const VT_UI8 = 21;
const VT_LPSTR = 30;
const VT_LPWSTR = 31;
const VT_FILETIME = 64;
const VT_BLOB = 65;
const VT_CF = 71;
const VT_DICTIONARY = 0x101f;

export type PropertyValue = string | number | boolean | Uint8Array;

export interface PropertySet {
  readonly fmtid: string;
  readonly properties: ReadonlyMap<number, PropertyValue>;
  /** The variant type (VT_*) each property was stored as. */
  readonly types: ReadonlyMap<number, number>;
  /** The raw FILETIME ticks (100 ns since 1601) of the properties stored as one. */
  readonly filetimes: ReadonlyMap<number, bigint>;
  /** Custom property names from the section dictionary (property ID 0). */
  readonly names: ReadonlyMap<number, string>;
}

interface RawProperty {
  readonly id: number;
  readonly type: number;
  readonly offset: number;
}

/** Parses an OLE property set stream (SummaryInformation et al.). */
export function parsePropertySets(data: Uint8Array): PropertySet[] {
  if (data.byteLength < 28) {
    throw new MalformedDocumentError("Truncated property set stream");
  }
  if (readUInt16(data, 0) !== 0xfffe) {
    throw new MalformedDocumentError("Invalid property set byte order");
  }

  const count = readUInt32(data, 24);
  const sets: PropertySet[] = [];
  for (let index = 0; index < count; index++) {
    const headerOffset = 28 + index * 20;
    if (headerOffset + 20 > data.byteLength) break;
    const fmtid = guid(data, headerOffset);
    const section = readUInt32(data, headerOffset + 16);
    if (section + 8 > data.byteLength) continue;
    sets.push(parseSection(data, section, fmtid));
  }
  return sets;
}

function parseSection(
  data: Uint8Array,
  section: number,
  fmtid: string,
): PropertySet {
  const declared = readUInt32(data, section);
  const end = Math.min(section + declared, data.byteLength);
  const count = readUInt32(data, section + 4);
  const raw: RawProperty[] = [];
  let codepage = 1252;

  for (let index = 0; index < count; index++) {
    const entry = section + 8 + index * 8;
    if (entry + 8 > end) break;
    const id = readUInt32(data, entry);
    const offset = readUInt32(data, entry + 4);
    const typeOffset = section + offset;
    if (typeOffset + 4 > end) continue;
    const type = readUInt16(data, typeOffset);
    raw.push({ id, type, offset });
    if (id === 1 && (type === VT_I2 || type === VT_UI2)) {
      codepage = readUInt16(data, typeOffset + 4);
    }
  }

  // The dictionary is property 0 and, unlike every other property, has no type word: its entry count is at the offset.
  const dictionary = raw.find((property) => property.id === 0);
  const names =
    dictionary === undefined
      ? new Map<number, string>()
      : readDictionary(data, section + dictionary.offset, codepage, end);

  const properties = new Map<number, PropertyValue>();
  const types = new Map<number, number>();
  const filetimes = new Map<number, bigint>();
  for (const property of raw) {
    if (property.id === 0) continue;
    const value = readValue(
      data,
      section + property.offset,
      property.type,
      codepage,
      end,
    );
    if (value === undefined) continue;
    properties.set(property.id, value);
    types.set(property.id, property.type & 0x0fff);
    if ((property.type & 0x0fff) === VT_FILETIME) {
      filetimes.set(property.id, readUInt64(data, section + property.offset + 4));
    }
  }
  return { fmtid, properties, types, filetimes, names };
}

function readDictionary(
  data: Uint8Array,
  offset: number,
  codepage: number,
  end: number,
): Map<number, string> {
  const names = new Map<number, string>();
  if (offset + 4 > end) return names;
  const count = readUInt32(data, offset);
  let position = offset + 4;
  const unicode = codepage === 1200;
  for (let index = 0; index < count && position + 8 <= end; index++) {
    const id = readUInt32(data, position);
    const length = readUInt32(data, position + 4);
    position += 8;
    // In a Unicode dictionary the length counts characters and each entry is padded to four bytes.
    const size = unicode ? length * 2 : length;
    const bytes = data.subarray(position, Math.min(position + size, end));
    position += unicode ? Math.ceil(size / 4) * 4 : size;
    const value = unicode
      ? decodeUtf16(bytes, 0, bytes.byteLength)
      : decodeAnsi(bytes, codepage);
    if (value.length > 0) names.set(id, value);
  }
  return names;
}

function readValue(
  data: Uint8Array,
  offset: number,
  type: number,
  codepage: number,
  end: number,
): PropertyValue | undefined {
  const base = type & 0x0fff;
  const valueOffset = offset + 4;
  switch (base) {
    case VT_I2:
      return readInt16(data, valueOffset);
    case VT_UI2:
      return readUInt16(data, valueOffset);
    case VT_I4:
      return readInt32(data, valueOffset);
    case VT_UI4:
      return readUInt32(data, valueOffset);
    case VT_I8:
    case VT_UI8:
      return Number(readUInt64(data, valueOffset));
    case VT_R4:
      return data.byteLength >= valueOffset + 4
        ? new Float32Array(
            data.slice(valueOffset, valueOffset + 4).buffer,
          )[0]
        : undefined;
    case VT_R8:
      return data.byteLength >= valueOffset + 8
        ? new Float64Array(
            data.slice(valueOffset, valueOffset + 8).buffer,
          )[0]
        : undefined;
    case VT_BOOL:
      return readUInt16(data, valueOffset) !== 0;
    case VT_LPSTR: {
      const length = readUInt32(data, valueOffset);
      const start = valueOffset + 4;
      const bytes = data.subarray(start, Math.min(start + length, end));
      return decodeAnsi(bytes, codepage);
    }
    case VT_LPWSTR: {
      const length = readUInt32(data, valueOffset);
      const start = valueOffset + 4;
      return decodeUtf16(data, start, Math.min(length * 2, end - start));
    }
    case VT_BSTR: {
      const length = readUInt32(data, valueOffset);
      const start = valueOffset + 4;
      return decodeUtf16(data, start, Math.min(length, end - start));
    }
    case VT_FILETIME:
      return filetime(readUInt64(data, valueOffset));
    case VT_BLOB:
    case VT_CF: {
      const length = readUInt32(data, valueOffset);
      const start = valueOffset + 4;
      return data.slice(start, Math.min(start + length, end));
    }
    default:
      return undefined;
  }
}

/**
 * Applies the property sets of one SummaryInformation or DocumentSummaryInformation stream to metadata, as Tika's
 * SummaryExtractor does with POI's readers: the first section's format id says which of the two it is, a
 * DocumentSummaryInformation stream's second section holds the custom properties named by its dictionary.
 */
export function applyPropertySetMetadata(
  metadata: Metadata,
  sets: readonly PropertySet[],
): void {
  const first = sets[0];
  if (first === undefined) return;
  if (first.fmtid === SUMMARY_INFORMATION) {
    applySummaryInformation(metadata, first);
  } else if (
    first.fmtid === DOCUMENT_SUMMARY_INFORMATION ||
    first.fmtid === USER_DEFINED_PROPERTIES
  ) {
    applyDocumentSummaryInformation(metadata, first);
    const custom = sets[1];
    if (custom !== undefined) applyCustomProperties(metadata, custom);
  }
}

function applySummaryInformation(metadata: Metadata, set: PropertySet): void {
  const values = set.properties;
  setText(metadata, "dc:title", values.get(2));
  addMulti(metadata, "dc:creator", values.get(4));
  // The keywords are the subject's first value, and also keep a key of their own.
  const keywords = text(values.get(5));
  if (keywords !== undefined) {
    metadata.set("meta:keyword", keywords);
    metadata.add("dc:subject", keywords);
  }
  const subject = text(values.get(3));
  if (subject !== undefined) metadata.add("dc:subject", subject);
  setText(metadata, "w:Comments", values.get(6));
  setText(metadata, "extended-properties:Template", values.get(7));
  setText(metadata, "meta:last-author", values.get(8));
  setText(metadata, "cp:revision", values.get(9));
  setText(metadata, "extended-properties:Application", values.get(18));
  // POI reads a date as a Date and throws on any other type; Tika stops there, with what it set so far and without the edit
  // time, the counts and the security. The order is Tika's: created, modified, last printed, then the edit time.
  for (const [id, key] of [
    [12, "dcterms:created"],
    [13, "dcterms:modified"],
    [11, "meta:print-date"],
  ] as const) {
    if (values.has(id) && !set.filetimes.has(id)) return;
    setDate(metadata, key, set, id);
  }
  if (values.has(10) && !set.filetimes.has(10)) return;
  // The edit time is POI's getEditTime: the ticks, but through a Date, so to the millisecond; 0 when there is none. The
  // stream always gives the key.
  const editTicks = ((set.filetimes.get(10) ?? 0n) / 10_000n) * 10_000n;
  metadata.set("extended-properties:TotalTime", String(editTicks));
  const pages = positiveInt(set, 14);
  if (pages !== undefined) {
    metadata.set("meta:page-count", pages);
    metadata.set("xmpTPg:NPages", pages);
  }
  setPositiveInt(metadata, "meta:word-count", set, 15);
  setPositiveInt(metadata, "meta:character-count", set, 16);
  setPositiveInt(metadata, "extended-properties:DocSecurity", set, 19);
}

function applyDocumentSummaryInformation(
  metadata: Metadata,
  set: PropertySet,
): void {
  const values = set.properties;
  setText(metadata, "cp:category", values.get(2));
  setPositiveInt(metadata, "meta:line-count", set, 5);
  setPositiveInt(metadata, "meta:paragraph-count", set, 6);
  // PowerPoint keeps its slide count here, and it is what Tika gives as the page count of the deck.
  const slides = positiveInt(set, 7);
  if (slides !== undefined) {
    metadata.set("meta:slide-count", slides);
    metadata.set("xmpTPg:NPages", slides);
  }
  addMulti(metadata, "extended-properties:Manager", values.get(14));
  setText(metadata, "extended-properties:Company", values.get(15));
}

/** A custom property is any value that has a dictionary name, as text; an unsigned int is read as the signed one POI gives. */
function applyCustomProperties(metadata: Metadata, set: PropertySet): void {
  for (const [id, name] of set.names) {
    const value = set.properties.get(id);
    if (value === undefined || value instanceof Uint8Array) continue;
    const signed =
      typeof value === "number" && set.types.get(id) === VT_UI4
        ? value | 0
        : value;
    metadata.set(`custom:${name}`, String(signed));
  }
}

/** A string, or the text of a number or boolean; a value that is blank is none. Not trimmed, as Tika keeps it. */
function text(value: PropertyValue | undefined): string | undefined {
  if (value === undefined || value instanceof Uint8Array) return undefined;
  const result = String(value);
  return result.trim().length === 0 ? undefined : result;
}

function setText(
  metadata: Metadata,
  key: string,
  value: PropertyValue | undefined,
): void {
  const result = text(value);
  if (result !== undefined) metadata.set(key, result);
}

/** Tika's addMulti: split at `;`, each piece as written, the blank ones dropped. */
function addMulti(
  metadata: Metadata,
  key: string,
  value: PropertyValue | undefined,
): void {
  const result = text(value);
  if (result === undefined) return;
  for (const piece of result.split(";")) {
    if (piece.trim().length > 0) metadata.add(key, piece);
  }
}

function setDate(
  metadata: Metadata,
  key: string,
  set: PropertySet,
  id: number,
): void {
  const ticks = set.filetimes.get(id);
  const date = ticks === undefined ? undefined : filetime(ticks);
  if (date !== undefined) metadata.set(key, date);
}

/** An int property (VT_I4 only, as POI reads one) above 0. */
function positiveInt(set: PropertySet, id: number): string | undefined {
  const value = set.properties.get(id);
  return set.types.get(id) === VT_I4 && typeof value === "number" && value > 0
    ? String(value)
    : undefined;
}

function setPositiveInt(
  metadata: Metadata,
  key: string,
  set: PropertySet,
  id: number,
): void {
  const value = positiveInt(set, id);
  if (value !== undefined) metadata.set(key, value);
}

function decodeAnsi(bytes: Uint8Array, codepage: number): string {
  const encoding = encodingFor(codepage);
  try {
    return new TextDecoder(encoding).decode(bytes).replace(/\0+$/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes).replace(/\0+$/, "");
  }
}

function encodingFor(codepage: number): string {
  switch (codepage) {
    case 65001:
      return "utf-8";
    case 1200:
      return "utf-16le";
    case 932:
      return "shift_jis";
    case 936:
      return "gbk";
    case 949:
      return "euc-kr";
    case 950:
      return "big5";
    default:
      return codepage >= 1250 && codepage <= 1258
        ? `windows-${codepage}`
        : "windows-1252";
  }
}

function decodeUtf16(data: Uint8Array, offset: number, length: number): string {
  let result = "";
  const end = Math.min(offset + length, data.byteLength);
  for (let index = offset; index + 1 < end; index += 2) {
    const code = readUInt16(data, index);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

/** A FILETIME as Tika writes a date: UTC, to the second (the ticks below it are dropped); 0 is 1601-01-01. */
function filetime(value: bigint): string | undefined {
  const seconds = Number(value / 10_000_000n) - 11_644_473_600;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(".000Z", "Z");
}

function guid(data: Uint8Array, offset: number): string {
  const hex = (start: number, length: number, bigEndian = false): string => {
    let result = "";
    const indexes = bigEndian
      ? Array.from({ length }, (_, index) => start + length - 1 - index)
      : Array.from({ length }, (_, index) => start + index);
    for (const index of indexes) {
      result += (data[index] ?? 0).toString(16).padStart(2, "0");
    }
    return result.toUpperCase();
  };
  return [
    hex(offset, 4, true),
    hex(offset + 4, 2, true),
    hex(offset + 6, 2, true),
    hex(offset + 8, 2),
    hex(offset + 10, 6),
  ].join("-");
}

function readUInt16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readInt16(data: Uint8Array, offset: number): number {
  const value = readUInt16(data, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function readUInt32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    ((data[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function readInt32(data: Uint8Array, offset: number): number {
  return readUInt32(data, offset) | 0;
}

function readUInt64(data: Uint8Array, offset: number): bigint {
  return (
    BigInt(readUInt32(data, offset)) |
    (BigInt(readUInt32(data, offset + 4)) << 32n)
  );
}

/**
 * The summary streams, as `SummaryExtractor.parseSummaries` reads them. A stream that is not a property set is left out of
 * the metadata and the container is still read (Tika ignores NoPropertySetStreamException); a limit or abort is not.
 */
export function applySummaries(compound: CompoundFile, metadata: Metadata): void {
  for (const name of SUMMARY_STREAMS) {
    if (!compound.has(name)) continue;
    try {
      applyPropertySetMetadata(metadata, parsePropertySets(compound.read(name)));
    } catch (error) {
      if (!(error instanceof MalformedDocumentError)) throw error;
    }
  }
}
