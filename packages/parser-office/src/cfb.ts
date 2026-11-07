import { MalformedDocumentError } from "@spikedpunch/ripstream-core";

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const MAX_REGULAR_SECTOR = 0xfffffffa;
const NO_STREAM = 0xffffffff;
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
const MAX_ENTRIES = 100_000;
const MAX_TREE_DEPTH = 4096;

export interface CompoundEntry {
  readonly path: string;
  readonly name: string;
  readonly type: "storage" | "stream" | "root";
  readonly size: number;
  readonly startSector: number;
}

/** Reader for the Compound File Binary (OLE2/CFB) container. */
export class CompoundFile {
  readonly #data: Uint8Array;
  readonly #sectorSize: number;
  readonly #miniSectorSize: number;
  readonly #miniCutoff: number;
  readonly #fat: Uint32Array;
  readonly #miniFat: Uint32Array;
  readonly #rootStart: number;
  readonly #rootSize: number;
  readonly entries: readonly CompoundEntry[];
  readonly #byPath: ReadonlyMap<string, CompoundEntry>;

  private constructor(data: Uint8Array) {
    if (!hasSignature(data)) {
      throw new MalformedDocumentError("Not a compound file");
    }
    if (data.byteLength < 512) {
      throw new MalformedDocumentError("Truncated compound file header");
    }
    this.#data = data;

    const sectorShift = readUInt16(data, 30);
    const miniSectorShift = readUInt16(data, 32);
    if (sectorShift < 7 || sectorShift > 16 || miniSectorShift > 16) {
      throw new MalformedDocumentError(
        `Invalid compound file sector shift: ${sectorShift}/${miniSectorShift}`,
      );
    }
    this.#sectorSize = 1 << sectorShift;
    this.#miniSectorSize = 1 << miniSectorShift;
    this.#miniCutoff = readUInt32(data, 56);

    const numFatSectors = readUInt32(data, 44);
    const firstDirectorySector = readUInt32(data, 48);
    const firstMiniFatSector = readUInt32(data, 60);
    const numMiniFatSectors = readUInt32(data, 64);
    const firstDifatSector = readUInt32(data, 68);
    const numDifatSectors = readUInt32(data, 72);

    const fatSectors = this.#difatSectors(
      numFatSectors,
      firstDifatSector,
      numDifatSectors,
    );
    this.#fat = this.#readFat(fatSectors);

    const directory = this.#readChain(
      firstDirectorySector,
      this.#fat,
      Infinity,
    );
    const directoryEntries = this.#parseDirectory(directory);

    const root = directoryEntries.find((entry) => entry.type === TYPE_ROOT);
    this.#rootStart = root?.startSector ?? END_OF_CHAIN;
    this.#rootSize = root === undefined ? 0 : Number(root.size);

    if (numMiniFatSectors === 0 || firstMiniFatSector === END_OF_CHAIN) {
      this.#miniFat = new Uint32Array(0);
    } else {
      const bytes = this.#readChain(
        firstMiniFatSector,
        this.#fat,
        numMiniFatSectors * this.#sectorSize,
      );
      this.#miniFat = new Uint32Array(Math.floor(bytes.byteLength / 4));
      for (let index = 0; index < this.#miniFat.length; index++) {
        this.#miniFat[index] = readUInt32(bytes, index * 4);
      }
    }

    const entries: CompoundEntry[] = [];
    const byPath = new Map<string, CompoundEntry>();
    const visited = new Set<number>();
    // Iterative in-order walk (left, self, child, right) so a hostile tree
    // cannot overflow the call stack; depth is capped instead.
    type Task = { id: number; prefix: string; depth: number; emit: boolean };
    const stack: Task[] = [
      { id: root?.child ?? NO_STREAM, prefix: "", depth: 0, emit: false },
    ];
    for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
      const { id, prefix, depth } = task;
      if (id === NO_STREAM || id >= directoryEntries.length) continue;
      const entry = directoryEntries[id];
      if (entry === undefined) continue;
      if (!task.emit) {
        if (visited.has(id)) {
          throw new MalformedDocumentError("Compound file directory loop");
        }
        if (depth > MAX_TREE_DEPTH) {
          throw new MalformedDocumentError("Compound file directory tree too deep");
        }
        visited.add(id);
        stack.push({ id: entry.right, prefix, depth: depth + 1, emit: false });
        stack.push({ id, prefix, depth, emit: true });
        stack.push({ id: entry.left, prefix, depth: depth + 1, emit: false });
        continue;
      }
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const kind =
        entry.type === TYPE_STREAM
          ? "stream"
          : entry.type === TYPE_ROOT
            ? "root"
            : "storage";
      const compound: CompoundEntry = {
        path,
        name: entry.name,
        type: kind,
        size: Number(entry.size),
        startSector: entry.startSector,
      };
      if (entry.type !== TYPE_ROOT && entry.name.length > 0) {
        entries.push(compound);
        byPath.set(path, compound);
      }
      if (entry.type === TYPE_STORAGE || entry.type === TYPE_ROOT) {
        stack.push({ id: entry.child, prefix: path, depth: depth + 1, emit: false });
      }
    }
    this.entries = entries;
    this.#byPath = byPath;
  }

  static parse(data: Uint8Array): CompoundFile {
    return new CompoundFile(data);
  }

  has(path: string): boolean {
    return this.#byPath.has(path);
  }

  get(path: string): CompoundEntry | undefined {
    return this.#byPath.get(path);
  }

  /** Reads a stream by path. Throws when the stream does not exist. */
  read(path: string): Uint8Array {
    const entry = this.#byPath.get(path);
    if (entry === undefined) {
      throw new MalformedDocumentError(`Missing compound stream: ${path}`);
    }
    if (entry.size === 0) return new Uint8Array(0);
    if (entry.size < this.#miniCutoff) {
      return this.#readMiniStream(entry.startSector, entry.size);
    }
    const data = this.#readChain(entry.startSector, this.#fat, entry.size);
    return data.subarray(0, entry.size);
  }

  #difatSectors(
    numFatSectors: number,
    firstDifatSector: number,
    numDifatSectors: number,
  ): number[] {
    const sectors: number[] = [];
    for (let index = 0; index < 109 && sectors.length < numFatSectors; index++) {
      const sector = readUInt32(this.#data, 76 + index * 4);
      if (sector <= MAX_REGULAR_SECTOR) sectors.push(sector);
    }

    let current = firstDifatSector;
    const perSector = this.#sectorSize / 4 - 1;
    const maxSectors = Math.floor(this.#data.byteLength / this.#sectorSize);
    if (numDifatSectors > maxSectors) {
      throw new MalformedDocumentError("Compound file DIFAT count exceeds data");
    }
    const seen = new Set<number>();
    for (let index = 0; index < numDifatSectors; index++) {
      if (current > MAX_REGULAR_SECTOR) break;
      if (seen.has(current)) {
        throw new MalformedDocumentError("Compound file DIFAT sector loop");
      }
      seen.add(current);
      const offset = this.#offset(current);
      for (let slot = 0; slot < perSector; slot++) {
        if (sectors.length >= numFatSectors) break;
        const sector = readUInt32(this.#data, offset + slot * 4);
        if (sector <= MAX_REGULAR_SECTOR) sectors.push(sector);
      }
      current = readUInt32(this.#data, offset + perSector * 4);
    }
    return sectors.slice(0, numFatSectors);
  }

  #readFat(sectors: number[]): Uint32Array {
    const expected = sectors.length * this.#sectorSize;
    if (expected > this.#data.byteLength + this.#sectorSize) {
      throw new MalformedDocumentError("Compound file FAT exceeds data");
    }
    const fat = new Uint32Array(sectors.length * (this.#sectorSize / 4));
    let index = 0;
    for (const sector of sectors) {
      const offset = this.#offset(sector);
      for (let slot = 0; slot < this.#sectorSize / 4; slot++) {
        fat[index++] = readUInt32(this.#data, offset + slot * 4);
      }
    }
    return fat;
  }

  #readChain(start: number, fat: Uint32Array, length: number): Uint8Array {
    if (start > MAX_REGULAR_SECTOR) return new Uint8Array(0);
    const limit = Math.min(
      Number.isFinite(length) ? length : Infinity,
      MAX_ENTRIES * this.#sectorSize,
    );
    const pieces: Uint8Array[] = [];
    let total = 0;
    let sector = start;
    const seen = new Set<number>();

    while (sector <= MAX_REGULAR_SECTOR && total < limit) {
      if (seen.has(sector)) {
        throw new MalformedDocumentError("Compound file sector loop");
      }
      seen.add(sector);
      const offset = this.#offset(sector);
      const available = Math.min(this.#sectorSize, this.#data.byteLength - offset);
      if (available <= 0) break;
      const take = Math.min(available, limit - total);
      pieces.push(this.#data.subarray(offset, offset + take));
      total += take;
      if (sector >= fat.length) break;
      sector = fat[sector]!;
    }

    const result = new Uint8Array(total);
    let position = 0;
    for (const piece of pieces) {
      result.set(piece, position);
      position += piece.byteLength;
    }
    return result;
  }

  #miniContainer: Uint8Array | undefined;

  #readMiniStream(start: number, size: number): Uint8Array {
    this.#miniContainer ??= this.#readChain(
      this.#rootStart,
      this.#fat,
      this.#rootSize,
    );
    const root = this.#miniContainer;
    const result = new Uint8Array(size);
    let written = 0;
    let sector = start;

    const seen = new Set<number>();
    while (sector <= MAX_REGULAR_SECTOR && written < size) {
      if (seen.has(sector)) {
        throw new MalformedDocumentError("Compound mini sector loop");
      }
      seen.add(sector);
      const offset = sector * this.#miniSectorSize;
      if (offset >= root.byteLength) break;
      const take = Math.min(this.#miniSectorSize, size - written);
      result.set(root.subarray(offset, offset + take), written);
      written += take;
      if (sector >= this.#miniFat.length) break;
      sector = this.#miniFat[sector]!;
    }
    return result;
  }

  #offset(sector: number): number {
    return (sector + 1) * this.#sectorSize;
  }

  #parseDirectory(directory: Uint8Array): DirectoryEntry[] {
    const entries: DirectoryEntry[] = [];
    const count = Math.floor(directory.byteLength / 128);
    if (count > MAX_ENTRIES) {
      throw new MalformedDocumentError("Too many compound file entries");
    }
    for (let index = 0; index < count; index++) {
      const offset = index * 128;
      const nameLength = readUInt16(directory, offset + 64);
      const type = directory[offset + 66] ?? 0;
      if (type === 0) {
        entries.push(emptyEntry());
        continue;
      }
      const name = decodeUtf16(directory, offset, Math.min(nameLength, 64));
      entries.push({
        name,
        type,
        left: readUInt32(directory, offset + 68),
        right: readUInt32(directory, offset + 72),
        child: readUInt32(directory, offset + 76),
        startSector: readUInt32(directory, offset + 116),
        size: readUInt64(directory, offset + 120),
      });
    }
    return entries;
  }
}

interface DirectoryEntry {
  readonly name: string;
  readonly type: number;
  readonly left: number;
  readonly right: number;
  readonly child: number;
  readonly startSector: number;
  readonly size: bigint;
}

function emptyEntry(): DirectoryEntry {
  return {
    name: "",
    type: 0,
    left: NO_STREAM,
    right: NO_STREAM,
    child: NO_STREAM,
    startSector: END_OF_CHAIN,
    size: 0n,
  };
}

/** True when the compound file contains OLE encryption streams. */
export function isEncryptedCompound(file: CompoundFile): boolean {
  return (
    file.has("EncryptionInfo") ||
    file.has("EncryptedPackage") ||
    file.has("EncryptedSummary")
  );
}

export function hasSignature(data: Uint8Array): boolean {
  if (data.byteLength < SIGNATURE.length) return false;
  return SIGNATURE.every((byte, index) => data[index] === byte);
}

function decodeUtf16(data: Uint8Array, offset: number, length: number): string {
  let result = "";
  const end = Math.min(offset + length, data.byteLength);
  for (let index = offset; index + 1 < end; index += 2) {
    const code = data[index]! | (data[index + 1]! << 8);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

function readUInt16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readUInt32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    ((data[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function readUInt64(data: Uint8Array, offset: number): bigint {
  return (
    BigInt(readUInt32(data, offset)) |
    (BigInt(readUInt32(data, offset + 4)) << 32n)
  );
}

export const CFB_FREE_SECTOR = FREE_SECTOR;
