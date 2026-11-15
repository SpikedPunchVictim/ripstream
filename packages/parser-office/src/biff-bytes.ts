/** The numbers, strings and caps the BIFF readers share: the .xls parser and the BIFF2-5 text reader of OldExcelParser. */

/** Cap on materialized (real plus padding) cells per sheet. */
export const MAX_SHEET_CELLS = 1_000_000;
/** Cap on the BIFF records of one stream; OldExcelParser shares it. */
export const MAX_BIFF_RECORDS = 2_000_000;

export function decodeRk(rk: number): number {
  let value: number;
  if ((rk & 0x02) !== 0) {
    value = rk >> 2;
  } else {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    value = new DataView(buffer).getFloat64(0, true);
  }
  return (rk & 0x01) !== 0 ? value / 100 : value;
}

export function readAnsi(
  data: Uint8Array,
  offset: number,
  length: number,
  codepage: number,
): string {
  const bytes = data.subarray(offset, offset + length);
  try {
    return new TextDecoder(encodingFor(codepage)).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function encodingFor(codepage: number): string {
  if (codepage === 65001) return "utf-8";
  // CODEPAGE 1200 (UTF-16) is what every Excel 97+ file declares. It describes the
  // uncompressed strings, which carry their own flag; an 8-bit ("compressed") string
  // is Latin-1, never UTF-16 (POI: StringUtil.getFromCompressedUnicode).
  if (codepage === 1200) return "windows-1252";
  if (codepage === 932) return "shift_jis";
  if (codepage === 936) return "gbk";
  if (codepage === 949) return "euc-kr";
  if (codepage === 950) return "big5";
  return codepage >= 1250 && codepage <= 1258
    ? `windows-${codepage}`
    : "windows-1252";
}

export function readDouble(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(
    0,
    true,
  );
}

export function readUInt16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

export function readUInt32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    ((data[offset + 3] ?? 0) << 24)
  ) >>> 0;
}
