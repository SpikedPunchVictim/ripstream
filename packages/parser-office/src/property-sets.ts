import { MalformedDocumentError, type Metadata } from "@spikedpunch/ripstream-core";

const SUMMARY_INFORMATION = "F29F85E0-4FF9-1068-AB91-08002B27B3D9";
const DOCUMENT_SUMMARY_INFORMATION = "D5CDD502-2E9C-101B-9397-08002B2CF9AE";

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

  const dictionary = raw.find((property) => property.id === 0);
  const names =
    dictionary === undefined
      ? new Map<number, string>()
      : readDictionary(data, section + dictionary.offset + 4, codepage, end);

  const properties = new Map<number, PropertyValue>();
  for (const property of raw) {
    if (property.id === 0 && property.type === VT_DICTIONARY) continue;
    const value = readValue(
      data,
      section + property.offset,
      property.type,
      codepage,
      end,
    );
    if (value !== undefined) properties.set(property.id, value);
  }
  return { fmtid, properties, names };
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
  for (let index = 0; index < count && position + 8 <= end; index++) {
    const id = readUInt32(data, position);
    const length = readUInt32(data, position + 4);
    position += 8;
    const bytes = data.subarray(position, Math.min(position + length, end));
    position += length;
    const value =
      codepage === 1200
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

/** Applies SummaryInformation and DocumentSummaryInformation to metadata. */
export function applyPropertySetMetadata(
  metadata: Metadata,
  sets: readonly PropertySet[],
): void {
  for (const set of sets) {
    const values = set.properties;
    for (const [id, name] of set.names) {
      assign(metadata, `custom:${name}`, values.get(id));
    }
    if (set.fmtid === SUMMARY_INFORMATION) {
      assign(metadata, "dc:title", values.get(2));
      assign(metadata, "dc:subject", values.get(3));
      assign(metadata, "dc:creator", values.get(4));
      assign(metadata, "pdf:Keywords", values.get(5));
      assign(metadata, "dc:description", values.get(6));
      assign(metadata, "cp:template", values.get(7));
      assign(metadata, "meta:last-author", values.get(8));
      assign(metadata, "cp:revision", values.get(9));
      assign(metadata, "meta:editTime", values.get(10));
      assign(metadata, "meta:lastPrinted", values.get(11));
      assign(metadata, "dcterms:created", values.get(12));
      assign(metadata, "dcterms:modified", values.get(13));
      assign(metadata, "meta:page-count", values.get(14));
      assign(metadata, "meta:word-count", values.get(15));
      assign(metadata, "meta:character-count", values.get(16));
      assign(metadata, "extended-properties:Application", values.get(18));
      assign(metadata, "extended-properties:Security", values.get(19));
    } else if (set.fmtid === DOCUMENT_SUMMARY_INFORMATION) {
      assign(metadata, "cp:category", values.get(2));
      assign(metadata, "meta:line-count", values.get(5));
      assign(metadata, "meta:paragraph-count", values.get(6));
      assign(metadata, "meta:slide-count", values.get(7));
      assign(metadata, "meta:note-count", values.get(8));
      assign(metadata, "meta:hidden-slide-count", values.get(9));
      assign(metadata, "meta:multimedia-clip-count", values.get(10));
      assign(metadata, "extended-properties:Manager", values.get(14));
      assign(metadata, "extended-properties:Company", values.get(15));
      assign(
        metadata,
        "meta:character-count-with-spaces",
        values.get(17),
      );
      assign(metadata, "extended-properties:AppVersion", values.get(23));
      assign(metadata, "cp:contentType", values.get(26));
      assign(metadata, "cp:contentStatus", values.get(27));
      assign(metadata, "dc:language", values.get(28));
      assign(metadata, "extended-properties:DocVersion", values.get(29));
    }
  }
}

function assign(metadata: Metadata, key: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (value.trim().length > 0) metadata.set(key, value.trim());
  } else if (typeof value === "number" || typeof value === "boolean") {
    metadata.set(key, String(value));
  }
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

function filetime(value: bigint): string | undefined {
  if (value === 0n) return undefined;
  const milliseconds = Number(value / 10_000n) - 11_644_473_600_000;
  const date = new Date(milliseconds);
  return Number.isFinite(milliseconds) ? date.toISOString() : undefined;
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
