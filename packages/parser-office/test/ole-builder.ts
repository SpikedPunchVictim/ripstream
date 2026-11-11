/*
 * A small OLE2 compound-file writer for tests: root-level streams only, each padded to 4096 bytes so it lives in ordinary
 * sectors. The layout is the one word-binary.test.ts uses, kept here so these tests do not depend on another test's file.
 */

const SECTOR = 512;
const NO_STREAM = 0xffffffff;

export interface OleStream {
  readonly name: string;
  readonly data: Uint8Array;
}

export function buildCompound(streams: readonly OleStream[]): Uint8Array {
  const sectorsPerStream = streams.map((stream) => Math.ceil(Math.max(stream.data.byteLength, 4096) / SECTOR));
  const directorySectors = Math.ceil(((streams.length + 1) * 128) / SECTOR);
  const firstDataSector = 2 + directorySectors;
  const totalSectors = firstDataSector + sectorsPerStream.reduce((sum, count) => sum + count, 0);
  const data = new Uint8Array(SECTOR + totalSectors * SECTOR);
  const view = new DataView(data.buffer);

  data.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(40, directorySectors, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, 0xfffffffe, true);
  view.setUint32(64, 0, true);
  view.setUint32(68, 0xfffffffe, true);
  view.setUint32(72, 0, true);
  view.setUint32(76, 0, true);
  for (let index = 1; index < 109; index++) view.setUint32(76 + index * 4, 0xffffffff, true);

  const fat = SECTOR;
  for (let index = 0; index < totalSectors + 1; index++) view.setUint32(fat + index * 4, 0xffffffff, true);
  view.setUint32(fat, 0xfffffffd, true);
  view.setUint32(fat + 4, 0xfffffffe, true);

  const directory = 2 * SECTOR;
  const writeEntry = (index: number, name: string, type: number, right: number, child: number, start: number, size: number): void => {
    const offset = directory + index * 128;
    for (let char = 0; char < name.length; char++) view.setUint16(offset + char * 2, name.charCodeAt(char), true);
    view.setUint16(offset + 64, (name.length + 1) * 2, true);
    data[offset + 66] = type;
    data[offset + 67] = 1;
    view.setUint32(offset + 68, 0xffffffff, true);
    view.setUint32(offset + 72, right, true);
    view.setUint32(offset + 76, child, true);
    view.setUint32(offset + 116, start, true);
    view.setUint32(offset + 120, size, true);
  };
  writeEntry(0, "Root Entry", 5, NO_STREAM, 1, 0, 0);

  let sector = firstDataSector;
  streams.forEach((stream, index) => {
    const count = sectorsPerStream[index]!;
    for (let offset = 0; offset < count; offset++) {
      const current = sector + offset;
      view.setUint32(fat + current * 4, offset === count - 1 ? 0xfffffffe : current + 1, true);
    }
    data.set(stream.data, (sector + 1) * SECTOR);
    writeEntry(index + 1, stream.name, 2, index + 1 < streams.length ? index + 2 : NO_STREAM, NO_STREAM, sector, Math.max(stream.data.byteLength, 4096));
    sector += count;
  });
  return data;
}

const SUMMARY_INFORMATION_FMTID = [0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9];
const DOCUMENT_SUMMARY_FMTID = [0x02, 0xd5, 0xcd, 0xd5, 0x9c, 0x2e, 0x1b, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2b, 0x2c, 0xf9, 0xae];

/** A SummaryInformation stream with only a title (property 2). */
export function summaryInformation(title: string): Uint8Array {
  return propertySet(SUMMARY_INFORMATION_FMTID, 2, title);
}

/** A DocumentSummaryInformation stream with only a company (property 15). */
export function documentSummaryInformation(company: string): Uint8Array {
  return propertySet(DOCUMENT_SUMMARY_FMTID, 15, company);
}

/** A property set stream of one section holding one string property. */
function propertySet(fmtid: readonly number[], propertyId: number, value: string): Uint8Array {
  const section = new Uint8Array(40);
  const view = new DataView(section.buffer);
  const entries = 16;
  view.setUint32(0, 40, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, propertyId, true);
  view.setUint32(12, entries, true);
  view.setUint16(entries, 30, true);
  const text = new TextEncoder().encode(`${value}\0`);
  view.setUint32(entries + 4, text.byteLength, true);
  section.set(text, entries + 8);

  const header = new Uint8Array(48);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, 0xfffe, true);
  headerView.setUint32(24, 1, true);
  header.set(fmtid, 28);
  headerView.setUint32(44, 48, true);

  const result = new Uint8Array(4096);
  result.set(header);
  result.set(section, header.byteLength);
  return result;
}
