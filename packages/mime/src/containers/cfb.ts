import { open, type FileHandle } from "node:fs/promises";

/** A storage (directory) or stream of a compound file; `children` is null for a stream. */
export interface CfbNode {
  readonly name: string;
  readonly children: readonly CfbNode[] | null;
  readonly startSector: number;
  readonly size: number;
}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEADER_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;
/** POI uses this constant, not the header field: a stream below it lives in the mini stream. */
const MINI_STREAM_CUTOFF = 4096;
/**
 * Entries that sit in more than one storage are built again for each, as POI does, so a crafted directory can make the
 * work quadratic; past this many such visits the file is refused.
 */
const MAX_REVISITS = 4096;
/** A big stream is searched this many sectors at a time. */
const SEARCH_CHUNK_SECTORS = 128;
const HEADER_FAT_SECTORS = 109;

const END_OF_CHAIN = 0xfffffffe;
const NO_INDEX = 0xffffffff;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

/**
 * Detection happens in the caller's process, before any parser limit applies, and every count in the header and
 * directory is attacker-controlled. Nothing is allocated from a claimed count: the FAT, the directory and the mini
 * store are read sector by sector up to these bounds, and a file that needs more reads as unreadable. They sit far
 * above real documents (8 MiB of FAT maps 1 GiB of 512-byte sectors; 8 MiB of directory is 65,536 entries).
 */
const MAX_FAT_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_MINI_FAT_BYTES = 1024 * 1024;
const MAX_MINI_STREAM_BYTES = 16 * 1024 * 1024;

interface DirectoryEntry {
  readonly name: string;
  readonly type: number;
  readonly left: number;
  readonly right: number;
  readonly child: number;
  readonly startSector: number;
  readonly size: number;
}

interface MutableNode {
  readonly name: string;
  readonly children: MutableNode[] | null;
  readonly startSector: number;
  readonly size: number;
}

/**
 * A read-only view of an OLE2 compound file (MS-CFB), opened once for a whole detection pass. It follows POI's
 * `POIFSFileSystem`, which is what Tika's detectors see: the tree is the red-black tree reachable from the root
 * entry, not a flat scan of the directory, and any structural fault (a chain loop, a sector outside the file, a
 * duplicate name in a storage) makes the whole file unreadable.
 */
export class CompoundFile {
  readonly root: CfbNode;
  private readonly handle: FileHandle;
  private readonly sectorSize: number;
  private readonly sectorCount: number;
  private readonly fat: Uint32Array;
  private readonly miniFat: Uint32Array;
  private miniStreamSectors: readonly number[] | null | undefined;

  private constructor(handle: FileHandle, structure: Structure) {
    this.handle = handle;
    this.sectorSize = structure.sectorSize;
    this.sectorCount = structure.sectorCount;
    this.fat = structure.fat;
    this.miniFat = structure.miniFat;
    this.root = structure.root;
  }

  /** Null when the file is not a readable compound file, or needs more than the detection bounds. */
  static async open(path: string): Promise<CompoundFile | null> {
    const handle = await open(path, "r");
    try {
      const structure = await readStructure(handle);
      if (structure === null) {
        await handle.close();
        return null;
      }
      return new CompoundFile(handle, structure);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /**
   * Which of `needles` occur anywhere in a stream, or null when the stream is unreadable (its chain is broken, loops,
   * or ends before its size). A big stream is searched a chunk at a time, so one of any size costs time, not memory;
   * Tika reads the whole stream, so a name placed a megabyte in still counts.
   */
  async findInStream(node: CfbNode, needles: readonly Uint8Array[]): Promise<boolean[] | null> {
    if (node.children !== null || node.size < 0) return null;
    const found = needles.map(() => false);
    const needleBuffers = needles.map((needle) => Buffer.from(needle));
    const search = (haystack: Uint8Array): void => {
      const buffer = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
      needleBuffers.forEach((needle, index) => {
        if (!found[index]) found[index] = buffer.includes(needle);
      });
    };

    if (node.size < MINI_STREAM_CUTOFF) {
      const data = await this.readMiniStream(node.startSector, node.size);
      if (data === null) return null;
      search(data);
      return found;
    }

    const sectors = followChain(node.startSector, this.fat, this.sectorCount, Math.ceil(node.size / this.sectorSize));
    if (sectors === null || sectors.length * this.sectorSize < node.size) return null;
    const overlap = Math.max(0, ...needles.map((needle) => needle.length)) - 1;
    let carry = new Uint8Array(0);
    let remaining = node.size;
    for (let first = 0; first < sectors.length && remaining > 0; first += SEARCH_CHUNK_SECTORS) {
      const chunk = await readSectors(this.handle, sectors.slice(first, first + SEARCH_CHUNK_SECTORS), this.sectorSize);
      const taken = Math.min(chunk.length, remaining);
      remaining -= taken;
      const window = new Uint8Array(carry.length + taken);
      window.set(carry);
      window.set(chunk.subarray(0, taken), carry.length);
      search(window);
      carry = window.slice(Math.max(0, window.length - overlap));
    }
    return found;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private async readMiniStream(start: number, length: number): Promise<Uint8Array | null> {
    const containerSectors = await this.loadMiniStreamSectors();
    if (containerSectors === null) return null;
    const miniSectors = followChain(start, this.miniFat, this.miniFat.length, Math.ceil(length / MINI_SECTOR_SIZE));
    if (miniSectors === null) return null;

    const data = new Uint8Array(miniSectors.length * MINI_SECTOR_SIZE);
    for (const [index, miniSector] of miniSectors.entries()) {
      const byteOffset = miniSector * MINI_SECTOR_SIZE;
      const containerSector = containerSectors[Math.floor(byteOffset / this.sectorSize)];
      if (containerSector === undefined) return null;
      const sector = await readSector(this.handle, containerSector, this.sectorSize);
      const within = byteOffset % this.sectorSize;
      data.set(sector.subarray(within, within + MINI_SECTOR_SIZE), index * MINI_SECTOR_SIZE);
    }
    return data.length >= length ? data.subarray(0, length) : null;
  }

  /** The sectors of the mini stream (the root entry's own stream), looked up on first use. */
  private async loadMiniStreamSectors(): Promise<readonly number[] | null> {
    if (this.miniStreamSectors === undefined) {
      this.miniStreamSectors = followChain(
        this.root.startSector,
        this.fat,
        this.sectorCount,
        Math.floor(MAX_MINI_STREAM_BYTES / this.sectorSize),
      );
    }
    return this.miniStreamSectors;
  }
}

interface Structure {
  readonly sectorSize: number;
  readonly sectorCount: number;
  readonly fat: Uint32Array;
  readonly miniFat: Uint32Array;
  readonly root: CfbNode;
}

async function readStructure(handle: FileHandle): Promise<Structure | null> {
  const headerBytes = await readAt(handle, 0, HEADER_SIZE);
  if (headerBytes.length < HEADER_SIZE) return null;
  if (!SIGNATURE.every((byte, index) => headerBytes[index] === byte)) return null;
  const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);

  // POI accepts 512 and 4096 byte sectors only.
  const sectorShift = header.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) return null;
  const sectorSize = 1 << sectorShift;
  const size = (await handle.stat()).size;
  // Sector n starts at (n + 1) * sectorSize; a final partial sector counts, zero padded as POI reads it.
  const sectorCount = Math.max(0, Math.ceil(size / sectorSize) - 1);

  // POI lets no sector serve twice among the FAT, the DIFAT and the mini FAT.
  const claimed = new Set<number>();
  const fatSectors = await readFatSectorIds(handle, header, sectorSize, sectorCount, claimed);
  if (fatSectors === null) return null;
  const fat = readFatEntries(await readSectors(handle, fatSectors, sectorSize));

  const miniFatSectors = followMiniFat(header, fat, sectorSize, sectorCount, claimed);
  if (miniFatSectors === null) return null;
  const miniFat = readFatEntries(await readSectors(handle, miniFatSectors, sectorSize));

  // One sector over the bound is read to tell a directory that ends there from one that goes on.
  const maxDirectorySectors = Math.floor(MAX_DIRECTORY_BYTES / sectorSize);
  const directorySectors = followChain(header.getUint32(48, true), fat, sectorCount, maxDirectorySectors + 1);
  if (directorySectors === null || directorySectors.length > maxDirectorySectors) return null;
  const root = buildTree(await readSectors(handle, directorySectors, sectorSize));
  if (root === null) return null;
  return { sectorSize, sectorCount, fat, miniFat, root };
}

/**
 * The sectors holding the FAT: the first `min(count, 109)` ids from the header, then the ids in the DIFAT chain. As in
 * POI, the counts are signed 32-bit ints (a DIFAT count of 0xFFFFFFFF is no DIFAT sectors), every DIFAT sector named
 * by the count is read, and each sector must be a distinct one inside the file. Null when any of that fails.
 */
async function readFatSectorIds(
  handle: FileHandle,
  header: DataView,
  sectorSize: number,
  sectorCount: number,
  claimed: Set<number>,
): Promise<number[] | null> {
  const fatCount = header.getInt32(44, true);
  const difatCount = header.getInt32(72, true);
  const entriesPerDifat = sectorSize / 4 - 1;
  const maxFatSectors = MAX_FAT_BYTES / sectorSize;
  if (fatCount < 1 || fatCount > Math.min(sectorCount, maxFatSectors)) return null;
  if (difatCount > Math.ceil(maxFatSectors / entriesPerDifat)) return null;

  const fatSectors: number[] = [];
  const claim = (sector: number): boolean => claimSector(claimed, sector, sectorCount);

  for (let index = 0; index < Math.min(fatCount, HEADER_FAT_SECTORS); index++) {
    const sector = header.getUint32(76 + index * 4, true);
    if (!claim(sector)) return null;
    fatSectors.push(sector);
  }

  let difat = header.getUint32(68, true);
  for (let index = 0; index < difatCount; index++) {
    if (!claim(difat)) return null;
    const bytes = await readSector(handle, difat, sectorSize);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let entry = 0; entry < entriesPerDifat && fatSectors.length < fatCount; entry++) {
      const sector = view.getUint32(entry * 4, true);
      if (sector === NO_INDEX || sector === END_OF_CHAIN) break;
      if (!claim(sector)) return null;
      fatSectors.push(sector);
    }
    difat = view.getUint32(entriesPerDifat * 4, true);
  }
  return fatSectors;
}

/**
 * POI loads the mini FAT when it opens a file, so a broken one makes the whole file unreadable even when no stream
 * needs it: `min(count, ...)` sectors from the header's start, stopping early at the end of the chain.
 */
function followMiniFat(
  header: DataView,
  fat: Uint32Array,
  sectorSize: number,
  sectorCount: number,
  claimed: Set<number>,
): number[] | null {
  const count = Math.min(header.getInt32(64, true), Math.floor(MAX_MINI_FAT_BYTES / sectorSize));
  const sectors: number[] = [];
  let at = header.getUint32(60, true);
  while (sectors.length < count && at !== END_OF_CHAIN) {
    if (!claimSector(claimed, at, sectorCount) || at >= fat.length) return null;
    sectors.push(at);
    at = fat[at]!;
  }
  return sectors;
}

/** Marks a sector as used; false for a sector outside the file or one already used. */
function claimSector(claimed: Set<number>, sector: number, sectorCount: number): boolean {
  if (sector >= sectorCount || claimed.has(sector)) return false;
  claimed.add(sector);
  return true;
}

/**
 * The first `maxSectors` sectors of a chain through a FAT (fewer when the chain ends first), or null for a loop or a
 * sector outside the file.
 */
function followChain(start: number, fat: Uint32Array, sectorLimit: number, maxSectors: number): number[] | null {
  const sectors: number[] = [];
  const seen = new Set<number>();
  let at = start;
  while (at !== END_OF_CHAIN && sectors.length < maxSectors) {
    if (at >= sectorLimit || at >= fat.length || seen.has(at)) return null;
    seen.add(at);
    sectors.push(at);
    at = fat[at]!;
  }
  return sectors;
}

/** POI builds a node only for storages, streams and the root; an entry of any other type is never read. */
function hasNode(directory: Uint8Array, index: number): boolean {
  const type = directory[index * DIRECTORY_ENTRY_SIZE + 66];
  return type === TYPE_STORAGE || type === TYPE_STREAM || type === TYPE_ROOT;
}

/** The entry at `index`, or null when its name length reaches past the 128-byte entry, which POI cannot read. */
function parseEntry(directory: Uint8Array, index: number): DirectoryEntry | null {
  const offset = index * DIRECTORY_ENTRY_SIZE;
  const view = new DataView(directory.buffer, directory.byteOffset + offset, DIRECTORY_ENTRY_SIZE);

  // POI reads the name length as a signed short and takes (length / 2 - 1) UTF-16 units from the start of the entry.
  const nameUnits = Math.trunc(view.getInt16(64, true) / 2) - 1;
  if (nameUnits > DIRECTORY_ENTRY_SIZE / 2) return null;
  let name = "";
  for (let unit = 0; unit < nameUnits; unit++) name += String.fromCharCode(view.getUint16(unit * 2, true));

  return {
    name,
    type: view.getUint8(66),
    left: view.getUint32(68, true),
    right: view.getUint32(72, true),
    child: view.getUint32(76, true),
    startSector: view.getUint32(116, true),
    // POI reads the size as a signed 32-bit int.
    size: view.getInt32(120, true),
  };
}

/**
 * POI's `populatePropertyTree`: from the root's child, each entry contributes its left and right siblings and, for a
 * storage, its own children. An entry of another type (unallocated, lock bytes) is skipped with its siblings. A
 * sibling index outside the directory is ignored, but a child index outside it (other than "none") is a fault, as is
 * a root that is not entry 0, a storage with children reached twice (a loop), and a duplicate name within one storage;
 * any fault makes the file unreadable. A stream, or a storage with no children, may sit in two storages, within a
 * budget of revisits. These rules are measured against Tika 4.2.0.
 */
function buildTree(directory: Uint8Array): CfbNode | null {
  const count = Math.floor(directory.length / DIRECTORY_ENTRY_SIZE);
  if (count === 0) return null;
  const rootEntry = parseEntry(directory, 0);
  if (rootEntry === null || rootEntry.type !== TYPE_ROOT) return null;

  const root: MutableNode = nodeOf(rootEntry);
  const placed = new Set<number>([0]);
  let revisits = 0;
  const storages: Array<{ node: MutableNode; firstChild: number }> = [{ node: root, firstChild: rootEntry.child }];
  while (storages.length > 0) {
    const { node, firstChild } = storages.pop()!;
    if (firstChild !== NO_INDEX && firstChild >= count) return null;
    const names = new Set<string>();
    const pending = firstChild === NO_INDEX ? [] : [firstChild];
    while (pending.length > 0) {
      const index = pending.pop()!;
      if (!hasNode(directory, index)) continue;
      const entry = parseEntry(directory, index);
      if (entry === null) return null;

      // POI builds a storage's children each time it is reached, so a storage with children reached twice adds them to
      // itself twice and fails on the duplicate name; a stream, or a storage with none, can sit in two storages.
      const again = placed.has(index);
      if (again && (entry.type !== TYPE_STREAM && entry.child !== NO_INDEX)) return null;
      if (again && ++revisits > MAX_REVISITS) return null;
      placed.add(index);

      if (names.has(entry.name)) return null;
      names.add(entry.name);
      const child = nodeOf(entry);
      node.children!.push(child);
      if (child.children !== null) storages.push({ node: child, firstChild: entry.child });
      if (entry.left < count) pending.push(entry.left);
      if (entry.right < count) pending.push(entry.right);
    }
  }
  return root;
}

function nodeOf(entry: DirectoryEntry): MutableNode {
  return {
    name: entry.name,
    children: entry.type === TYPE_STREAM ? null : [],
    startSector: entry.startSector,
    size: entry.size,
  };
}

function readFatEntries(sectors: Uint8Array): Uint32Array {
  const view = new DataView(sectors.buffer, sectors.byteOffset, sectors.byteLength);
  const entries = new Uint32Array(Math.floor(sectors.length / 4));
  for (let index = 0; index < entries.length; index++) entries[index] = view.getUint32(index * 4, true);
  return entries;
}

async function readSectors(handle: FileHandle, sectors: readonly number[], sectorSize: number): Promise<Uint8Array> {
  const data = new Uint8Array(sectors.length * sectorSize);
  for (const [index, sector] of sectors.entries()) {
    data.set(await readSector(handle, sector, sectorSize), index * sectorSize);
  }
  return data;
}

/** One sector, zero padded when the file ends inside it (POI reads a truncated final sector the same way). */
async function readSector(handle: FileHandle, sector: number, sectorSize: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(sectorSize);
  await handle.read(buffer, 0, sectorSize, (sector + 1) * sectorSize);
  return buffer;
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}
