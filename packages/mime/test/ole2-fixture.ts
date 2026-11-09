/**
 * Builds an OLE2 compound file with stream contents, for detectors that read an entry's bytes as well as its names.
 * Streams under 4096 bytes go in the mini stream and larger ones in regular sectors, as in a real file. Each
 * storage's children are one right-hand sibling chain.
 *
 * Layout, in sector order: directory, mini FAT, mini stream, regular streams, FAT, DIFAT. Sectors are 512 bytes, or
 * 4096 with `sectorSize`; the first sector starts after a header the size of one sector.
 */
export interface Ole2Entry {
  readonly name: string;
  /** Present for a storage (possibly empty). */
  readonly children?: readonly Ole2Entry[];
  /** Stream contents; absent for an empty stream. */
  readonly data?: Uint8Array;
}

const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;
const MINI_STREAM_CUTOFF = 4096;
const HEADER_FAT_SECTORS = 109;
const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface FlatEntry {
  readonly name: string;
  readonly type: number;
  readonly data: Uint8Array;
  rightIndex: number;
  childIndex: number;
  startSector: number;
}

export function ole2(root: readonly Ole2Entry[], sectorSize: 512 | 4096 = 512): Uint8Array {
  const entriesPerSector = sectorSize / 4;
  const flat: FlatEntry[] = [
    { name: "Root Entry", type: 5, data: new Uint8Array(), rightIndex: FREE, childIndex: FREE, startSector: END_OF_CHAIN },
  ];
  flat[0]!.childIndex = flatten(root, flat);

  const small = flat.filter((entry) => entry.type === 2 && entry.data.length > 0 && entry.data.length < MINI_STREAM_CUTOFF);
  const large = flat.filter((entry) => entry.type === 2 && entry.data.length >= MINI_STREAM_CUTOFF);
  const miniCounts = small.map((entry) => Math.ceil(entry.data.length / MINI_SECTOR_SIZE));
  const miniTotal = miniCounts.reduce((sum, count) => sum + count, 0);
  const largeCounts = large.map((entry) => Math.ceil(entry.data.length / sectorSize));

  const directorySectors = Math.ceil(flat.length / (sectorSize / ENTRY_SIZE));
  const miniFatSectors = Math.ceil(miniTotal / entriesPerSector);
  const miniStreamSectors = Math.ceil((miniTotal * MINI_SECTOR_SIZE) / sectorSize);
  const dataSectors = directorySectors + miniFatSectors + miniStreamSectors + largeCounts.reduce((sum, count) => sum + count, 0);

  // The FAT must also map the sectors that hold it and the DIFAT sectors that list it.
  const difatPerSector = entriesPerSector - 1;
  let fatSectors = 1;
  let difatSectors = 0;
  for (;;) {
    difatSectors = Math.max(0, Math.ceil((fatSectors - HEADER_FAT_SECTORS) / difatPerSector));
    const needed = Math.ceil((dataSectors + fatSectors + difatSectors) / entriesPerSector);
    if (needed <= fatSectors) break;
    fatSectors = needed;
  }

  const bytes = new Uint8Array(sectorSize * (1 + dataSectors + fatSectors + difatSectors));
  const view = new DataView(bytes.buffer);
  const fat = new Array<number>(fatSectors * entriesPerSector).fill(FREE);
  const sectorOffset = (sector: number): number => sectorSize * (1 + sector);
  const chain = (first: number, count: number): void => {
    for (let index = 0; index < count; index++) fat[first + index] = index + 1 < count ? first + index + 1 : END_OF_CHAIN;
  };

  let next = 0;
  const directoryStart = next;
  chain(next, directorySectors);
  next += directorySectors;

  const miniFatStart = miniFatSectors > 0 ? next : END_OF_CHAIN;
  chain(next, miniFatSectors);
  next += miniFatSectors;

  const miniStreamStart = miniStreamSectors > 0 ? next : END_OF_CHAIN;
  chain(next, miniStreamSectors);
  const miniStreamOffset = sectorOffset(next);
  next += miniStreamSectors;

  let miniAt = 0;
  small.forEach((entry, index) => {
    const count = miniCounts[index]!;
    entry.startSector = miniAt;
    bytes.set(entry.data, miniStreamOffset + miniAt * MINI_SECTOR_SIZE);
    for (let sector = 0; sector < count; sector++) {
      const value = sector + 1 < count ? miniAt + sector + 1 : END_OF_CHAIN;
      view.setUint32(sectorOffset(miniFatStart) + (miniAt + sector) * 4, value, true);
    }
    miniAt += count;
  });
  for (let slot = miniTotal; slot < miniFatSectors * entriesPerSector; slot++) {
    view.setUint32(sectorOffset(miniFatStart) + slot * 4, FREE, true);
  }

  large.forEach((entry, index) => {
    const count = largeCounts[index]!;
    entry.startSector = next;
    bytes.set(entry.data, sectorOffset(next));
    chain(next, count);
    next += count;
  });

  const fatStart = next;
  for (let index = 0; index < fatSectors; index++) fat[fatStart + index] = FAT_SECTOR;
  const difatStart = difatSectors > 0 ? fatStart + fatSectors : END_OF_CHAIN;
  for (let index = 0; index < difatSectors; index++) fat[fatStart + fatSectors + index] = DIFAT_SECTOR;
  fat.forEach((value, index) => view.setUint32(sectorOffset(fatStart) + index * 4, value, true));

  for (let index = 0; index < difatSectors; index++) {
    const offset = sectorOffset(fatStart + fatSectors + index);
    for (let slot = 0; slot < difatPerSector; slot++) {
      const fatIndex = HEADER_FAT_SECTORS + index * difatPerSector + slot;
      view.setUint32(offset + slot * 4, fatIndex < fatSectors ? fatStart + fatIndex : FREE, true);
    }
    const nextDifat = index + 1 < difatSectors ? fatStart + fatSectors + index + 1 : END_OF_CHAIN;
    view.setUint32(offset + difatPerSector * 4, nextDifat, true);
  }

  flat[0]!.startSector = miniStreamStart;
  const sizes = flat.map((entry, index) => (index === 0 ? miniTotal * MINI_SECTOR_SIZE : entry.data.length));
  flat.forEach((entry, index) => writeEntry(view, sectorOffset(directoryStart) + index * ENTRY_SIZE, entry, sizes[index]!));
  for (let index = flat.length; index < directorySectors * (sectorSize / ENTRY_SIZE); index++) {
    writeEntry(view, sectorOffset(directoryStart) + index * ENTRY_SIZE, null, 0);
  }

  writeHeader(view, sectorSize, { fatSectors, fatStart, directoryStart, miniFatStart, miniFatSectors, difatStart, difatSectors });
  return bytes;
}

/** Appends `entries` as one sibling chain and returns the index of its first member. */
function flatten(entries: readonly Ole2Entry[], flat: FlatEntry[]): number {
  let first = FREE;
  let previous: FlatEntry | null = null;
  for (const entry of entries) {
    const index = flat.length;
    const record: FlatEntry = {
      name: entry.name,
      type: entry.children === undefined ? 2 : 1,
      data: entry.data ?? new Uint8Array(),
      rightIndex: FREE,
      childIndex: FREE,
      startSector: END_OF_CHAIN,
    };
    flat.push(record);
    if (previous === null) first = index;
    else previous.rightIndex = index;
    previous = record;
    if (entry.children !== undefined) record.childIndex = flatten(entry.children, flat);
  }
  return first;
}

interface HeaderFields {
  readonly fatSectors: number;
  readonly fatStart: number;
  readonly directoryStart: number;
  readonly miniFatStart: number;
  readonly miniFatSectors: number;
  readonly difatStart: number;
  readonly difatSectors: number;
}

function writeHeader(view: DataView, sectorSize: number, fields: HeaderFields): void {
  SIGNATURE.forEach((byte, index) => view.setUint8(index, byte));
  view.setUint16(24, 0x003e, true); // minor version
  view.setUint16(26, sectorSize === 512 ? 3 : 4, true); // major version
  view.setUint16(28, 0xfffe, true); // byte order
  view.setUint16(30, sectorSize === 512 ? 9 : 12, true); // sector shift
  view.setUint16(32, 6, true); // mini sector shift
  view.setUint32(44, fields.fatSectors, true);
  view.setUint32(48, fields.directoryStart, true);
  view.setUint32(56, MINI_STREAM_CUTOFF, true);
  view.setUint32(60, fields.miniFatStart, true);
  view.setUint32(64, fields.miniFatSectors, true);
  view.setUint32(68, fields.difatStart, true);
  view.setUint32(72, fields.difatSectors, true);
  for (let index = 0; index < HEADER_FAT_SECTORS; index++) {
    view.setUint32(76 + index * 4, index < fields.fatSectors ? fields.fatStart + index : FREE, true);
  }
}

function writeEntry(view: DataView, offset: number, entry: FlatEntry | null, size: number): void {
  view.setUint32(offset + 68, FREE, true); // left sibling
  view.setUint32(offset + 72, entry?.rightIndex ?? FREE, true);
  view.setUint32(offset + 76, entry?.childIndex ?? FREE, true);
  if (entry === null) return;

  if (entry.name.length > 31) throw new Error(`entry name too long: ${entry.name}`);
  for (let index = 0; index < entry.name.length; index++) {
    view.setUint16(offset + index * 2, entry.name.charCodeAt(index), true);
  }
  view.setUint16(offset + 64, (entry.name.length + 1) * 2, true);
  view.setUint8(offset + 66, entry.type);
  view.setUint8(offset + 67, 1); // black
  view.setUint32(offset + 116, entry.startSector, true);
  view.setUint32(offset + 120, size, true);
}

/** A fixture as data, so a golden file can record it: entries, then byte patches, then truncation. */
export interface Ole2Spec {
  readonly entries: readonly SpecEntry[];
  readonly sectorSize?: 512 | 4096;
  /** Overwrites `width` bytes at `offset` (little-endian) in the built file. */
  readonly patches?: readonly { readonly offset: number; readonly width: 1 | 2 | 4; readonly value: number }[];
  readonly truncateTo?: number;
}

export interface SpecEntry {
  readonly name: string;
  /** Present for a storage. */
  readonly children?: readonly SpecEntry[];
  /** A stream of `length` zero bytes (at least long enough for `text`) with Latin-1 `text` written at `textAt`. */
  readonly text?: string;
  readonly textAt?: number;
  readonly length?: number;
}

export function ole2FromSpec(spec: Ole2Spec): Uint8Array {
  const bytes = ole2(spec.entries.map(toEntry), spec.sectorSize);
  const view = new DataView(bytes.buffer);
  for (const { offset, width, value } of spec.patches ?? []) {
    if (width === 1) view.setUint8(offset, value);
    else if (width === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
  }
  return spec.truncateTo === undefined ? bytes : bytes.subarray(0, spec.truncateTo);
}

function toEntry(entry: SpecEntry): Ole2Entry {
  if (entry.children !== undefined) return { name: entry.name, children: entry.children.map(toEntry) };
  if (entry.text === undefined && entry.length === undefined) return { name: entry.name };
  const text = Buffer.from(entry.text ?? "", "latin1");
  const textAt = entry.textAt ?? 0;
  const data = new Uint8Array(Math.max(entry.length ?? 0, textAt + text.length));
  data.set(text, textAt);
  return { name: entry.name, data };
}
