/*
 * Builders for small Compound File Binary (OLE2) documents and property sets, for tests that need an exact container
 * (a hostile length, a truncated copy) the Tika test documents cannot give. Written from the [MS-CFB] and [MS-OLEPS]
 * layouts; the CFB reader of parser-office is the only reader these files have been through.
 */

const SECTOR = 512;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const FREE = 0xffffffff;
const DIRECTORY_ENTRY = 128;

export interface OleStream {
  readonly name: string;
  readonly data: Uint8Array;
  /** An entry that is a storage, not a stream: it has no data of its own, whatever `data` says. */
  readonly storage?: true;
}

export interface OleOptions {
  /**
   * Header "mini stream cutoff". The default 0 keeps every stream in regular sectors, so no mini stream is needed;
   * a large value makes the reader take its mini stream path for a stream whose declared size is below it.
   */
  readonly miniCutoff?: number;
  /** Replaces the size a stream declares in its directory entry, by stream name, without changing its sectors. */
  readonly declaredSize?: Readonly<Record<string, number>>;
}

/** A version 3 compound file with `streams` directly under the root storage. */
export function buildOle(streams: readonly OleStream[], options: OleOptions = {}): Uint8Array {
  const dataSectors = streams.map((stream) => (stream.storage === true ? 0 : Math.ceil(stream.data.length / SECTOR)));
  const dataTotal = dataSectors.reduce((sum, count) => sum + count, 0);
  const directorySectors = Math.ceil((streams.length + 1) / (SECTOR / DIRECTORY_ENTRY));
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < dataTotal + directorySectors + fatSectors) fatSectors++;
  const total = dataTotal + directorySectors + fatSectors;

  const bytes = new Uint8Array(SECTOR * (1 + total));
  const view = new DataView(bytes.buffer);
  const sectorOffset = (sector: number): number => SECTOR * (1 + sector);

  // Stream data first, then the directory, then the FAT.
  const starts: number[] = [];
  const fat = new Uint32Array(fatSectors * (SECTOR / 4)).fill(FREE);
  let next = 0;
  streams.forEach((stream, index) => {
    const count = dataSectors[index]!;
    starts.push(count === 0 ? END_OF_CHAIN : next);
    bytes.set(stream.data, sectorOffset(next));
    for (let step = 0; step < count; step++) fat[next + step] = step === count - 1 ? END_OF_CHAIN : next + step + 1;
    next += count;
  });
  const directoryStart = next;
  for (let step = 0; step < directorySectors; step++) {
    fat[next + step] = step === directorySectors - 1 ? END_OF_CHAIN : next + step + 1;
  }
  next += directorySectors;
  const fatStart = next;
  for (let step = 0; step < fatSectors; step++) fat[fatStart + step] = FAT_SECTOR;

  writeHeader(view, fatSectors, fatStart, directoryStart, options.miniCutoff ?? 0);
  fat.forEach((value, index) => view.setUint32(sectorOffset(fatStart) + index * 4, value, true));

  const directory = sectorOffset(directoryStart);
  writeEntry(bytes, view, directory, { name: "Root Entry", type: 5, child: streams.length > 0 ? 1 : FREE });
  streams.forEach((stream, index) => {
    writeEntry(bytes, view, directory + (index + 1) * DIRECTORY_ENTRY, {
      name: stream.name,
      type: stream.storage === true ? 1 : 2,
      // The streams are chained through "right" siblings; the reader walks left, self, right without comparing names.
      right: index + 1 < streams.length ? index + 2 : FREE,
      start: starts[index]!,
      size: options.declaredSize?.[stream.name] ?? (stream.storage === true ? 0 : stream.data.length),
    });
  });
  // Unused slots of the last directory sector are free entries: type 0 and every link unset.
  for (let slot = streams.length + 1; slot < directorySectors * (SECTOR / DIRECTORY_ENTRY); slot++) {
    writeEntry(bytes, view, directory + slot * DIRECTORY_ENTRY, { name: "", type: 0 });
  }
  return bytes;
}

function writeHeader(view: DataView, fatSectors: number, fatStart: number, directoryStart: number, miniCutoff: number): void {
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((byte, index) => view.setUint8(index, byte));
  view.setUint16(24, 0x003e, true); // minor version
  view.setUint16(26, 3, true); // major version
  view.setUint16(28, 0xfffe, true); // byte order
  view.setUint16(30, 9, true); // sector shift: 512
  view.setUint16(32, 6, true); // mini sector shift: 64
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, directoryStart, true);
  view.setUint32(56, miniCutoff, true);
  view.setUint32(60, END_OF_CHAIN, true); // no mini FAT
  view.setUint32(68, END_OF_CHAIN, true); // no extra DIFAT sectors
  for (let index = 0; index < 109; index++) {
    view.setUint32(76 + index * 4, index < fatSectors ? fatStart + index : FREE, true);
  }
}

interface EntryFields {
  readonly name: string;
  readonly type: number;
  readonly right?: number;
  readonly child?: number;
  readonly start?: number;
  readonly size?: number;
}

function writeEntry(bytes: Uint8Array, view: DataView, offset: number, fields: EntryFields): void {
  for (let index = 0; index < fields.name.length; index++) {
    view.setUint16(offset + index * 2, fields.name.charCodeAt(index), true);
  }
  view.setUint16(offset + 64, fields.name.length === 0 ? 0 : (fields.name.length + 1) * 2, true);
  bytes[offset + 66] = fields.type;
  bytes[offset + 67] = 1; // black
  view.setUint32(offset + 68, FREE, true); // left
  view.setUint32(offset + 72, fields.right ?? FREE, true);
  view.setUint32(offset + 76, fields.child ?? FREE, true);
  view.setUint32(offset + 116, fields.start ?? END_OF_CHAIN, true);
  view.setUint32(offset + 120, fields.size ?? 0, true);
}

export type SummaryValue = string | number;

/**
 * A property set stream with one section of the given format id (SummaryInformation, DocumentSummaryInformation).
 * Strings are written as VT_LPSTR in Windows-1252, whole numbers as VT_I4.
 */
export function buildPropertySet(fmtid: readonly number[], properties: Readonly<Record<number, SummaryValue>>): Uint8Array {
  const ids = Object.keys(properties).map(Number);
  const values = ids.map((id) => encodeValue(properties[id]!));
  const tableLength = 8 + ids.length * 8;
  const sectionLength = tableLength + values.reduce((sum, value) => sum + value.length, 0);
  const bytes = new Uint8Array(48 + sectionLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfffe, true); // byte order
  view.setUint32(24, 1, true); // one section
  bytes.set(fmtid, 28);
  view.setUint32(44, 48, true); // section offset
  view.setUint32(48, sectionLength, true);
  view.setUint32(52, ids.length, true);
  let valueOffset = tableLength;
  ids.forEach((id, index) => {
    view.setUint32(56 + index * 8, id, true);
    view.setUint32(60 + index * 8, valueOffset, true);
    bytes.set(values[index]!, 48 + valueOffset);
    valueOffset += values[index]!.length;
  });
  return bytes;
}

function encodeValue(value: SummaryValue): Uint8Array {
  if (typeof value === "number") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, 3, true); // VT_I4
    new DataView(bytes.buffer).setInt32(4, value, true);
    return bytes;
  }
  const text = new TextEncoder().encode(`${value}\0`);
  const bytes = new Uint8Array(8 + Math.ceil(text.length / 4) * 4);
  new DataView(bytes.buffer).setUint32(0, 30, true); // VT_LPSTR
  new DataView(bytes.buffer).setUint32(4, text.length, true);
  bytes.set(text, 8);
  return bytes;
}

/** FMTID_SummaryInformation {F29F85E0-4FF9-1068-AB91-08002B27B3D9} in its byte order. */
export const SUMMARY_INFORMATION_FMTID: readonly number[] = [
  0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9,
];

/** FMTID_DocumentSummaryInformation {D5CDD502-2E9C-101B-9397-08002B2CF9AE} in its byte order. */
export const DOCUMENT_SUMMARY_INFORMATION_FMTID: readonly number[] = [
  0x02, 0xd5, 0xcd, 0xd5, 0x9c, 0x2e, 0x1b, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2b, 0x2c, 0xf9, 0xae,
];
