/*
 * Builds Unix dump(8) volumes for the tests, byte by byte, as commons-compress's DumpArchiveInputStream reads them
 * (the layout is from memory of that source, which is not in the Tika tree; no real dump file was available).
 * Every record is 1024 bytes, little endian: a header whose last field is a checksum that makes the 256 words sum to
 * 84446, followed by the data blocks the header's address map says are on the tape.
 */

export const RECORD = 1024;
export const NFS_MAGIC = 60012;
const CHECKSUM = 84446;

export const SEGMENT = { TAPE: 1, INODE: 2, BITS: 3, ADDR: 4, END: 5, CLRI: 6 } as const;
export const MODE = { FILE: 0o100644, DIRECTORY: 0o040755, LINK: 0o120777 } as const;

export interface HeaderFields {
  readonly type: number;
  readonly ino?: number;
  readonly mode?: number;
  readonly size?: bigint | number;
  readonly count?: number;
  /** The address map: true where the block is on the tape, false for a hole. Positions past it are holes. */
  readonly present?: readonly boolean[];
  /** The address map as raw bytes, for maps that `present` cannot say (a byte of 2 or 3). Applied after `present`. */
  readonly addresses?: readonly number[];
  readonly mtimeSeconds?: number;
  readonly mtimeNanoseconds?: number;
  readonly flags?: number;
  readonly ntrec?: number;
  readonly magic?: number;
  /** Leaves the checksum field as it is instead of fixing it up. */
  readonly badChecksum?: boolean;
}

export function header(fields: HeaderFields): Uint8Array {
  const bytes = new Uint8Array(RECORD);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, fields.type, true);
  view.setInt32(4, 1_700_000_000, true);
  view.setInt32(12, 1, true);
  view.setUint32(20, fields.ino ?? 0, true);
  view.setInt32(24, fields.magic ?? NFS_MAGIC, true);
  view.setUint16(32, fields.mode ?? 0, true);
  view.setUint16(34, 1, true);
  view.setBigInt64(40, BigInt(fields.size ?? 0), true);
  view.setInt32(56, fields.mtimeSeconds ?? 0, true);
  view.setInt32(60, fields.mtimeNanoseconds ?? 0, true);
  view.setInt32(160, fields.count ?? 0, true);
  (fields.present ?? []).forEach((onTape, index) => {
    bytes[164 + index] = onTape ? 1 : 0;
  });
  (fields.addresses ?? []).forEach((value, index) => {
    bytes[164 + index] = value;
  });
  view.setInt32(888, fields.flags ?? 0, true);
  view.setInt32(896, fields.ntrec ?? 10, true);
  if (fields.badChecksum !== true) {
    let sum = 0;
    for (let word = 0; word < 256; word++) {
      if (word !== 7) sum = (sum + view.getInt32(4 * word, true)) | 0;
    }
    view.setInt32(28, (CHECKSUM - sum) | 0, true);
  }
  return bytes;
}

/** `data` cut into whole records, the last one zero padded. */
export function blocks(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += RECORD) {
    const block = new Uint8Array(RECORD);
    block.set(data.subarray(offset, offset + RECORD));
    out.push(block);
  }
  return out;
}

export interface Dirent {
  readonly ino: number;
  readonly name: string;
  readonly reclen?: number;
}

/** A directory's data: struct direct entries chained by reclen, the last one reaching the end of the last block. */
export function directoryData(entries: readonly Dirent[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = entries.map((entry) => ({ entry, name: encoder.encode(entry.name) }));
  const lengths = parts.map((part) => 8 + Math.ceil((part.name.length + 1) / 4) * 4);
  const total = Math.max(RECORD, Math.ceil(lengths.reduce((a, b) => a + b, 0) / RECORD) * RECORD);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    view.setUint32(offset, part.entry.ino, true);
    view.setUint16(offset + 4, part.entry.reclen ?? (last ? total - offset : lengths[index]!), true);
    bytes[offset + 6] = 8;
    bytes[offset + 7] = part.name.length;
    bytes.set(part.name, offset + 8);
    offset += lengths[index]!;
  });
  return bytes;
}

export interface InodeOptions {
  readonly mtimeSeconds?: number;
  readonly mtimeNanoseconds?: number;
  /** Blocks that are holes, by index into the file's blocks. */
  readonly holes?: ReadonlySet<number>;
  /** The size field, when it is not the data's length. */
  readonly size?: bigint | number;
}

/** An inode segment: its header, then (past 512 blocks, an ADDR header before each further 512) its blocks. */
export function inode(ino: number, mode: number, data: Uint8Array, options: InodeOptions = {}): Uint8Array[] {
  const all = blocks(data);
  const out: Uint8Array[] = [];
  for (let start = 0; start === 0 || start < all.length; start += 512) {
    const slice = all.slice(start, start + 512);
    const present = slice.map((_, index) => options.holes?.has(start + index) !== true);
    out.push(
      header({
        type: start === 0 ? SEGMENT.INODE : SEGMENT.ADDR,
        ino,
        mode,
        size: options.size ?? data.length,
        count: slice.length,
        present,
        mtimeSeconds: options.mtimeSeconds ?? 0,
        mtimeNanoseconds: options.mtimeNanoseconds ?? 0,
      }),
    );
    slice.forEach((block, index) => {
      if (present[index]) out.push(block);
    });
  }
  return out;
}

/** The records every volume starts with: the volume header, then the CLRI and BITS maps (one block each). */
export function prologue(fields: Partial<HeaderFields> = {}): Uint8Array[] {
  return [
    header({ type: SEGMENT.TAPE, ino: 0, ...fields }),
    header({ type: SEGMENT.CLRI, count: 1, present: [true] }),
    new Uint8Array(RECORD),
    header({ type: SEGMENT.BITS, count: 1, present: [true] }),
    new Uint8Array(RECORD),
  ];
}

export const END_RECORD = (): Uint8Array => header({ type: SEGMENT.END });

/** Records joined, with zero records added up to a whole 10-record block, as dump writes the tape. */
export function volume(records: readonly Uint8Array[]): Uint8Array {
  const total = Math.ceil(records.length / 10) * 10;
  const bytes = new Uint8Array(total * RECORD);
  records.forEach((record, index) => bytes.set(record, index * RECORD));
  return bytes;
}

export interface TreeFile {
  readonly path: string;
  readonly data: Uint8Array;
  readonly mtimeSeconds?: number;
  readonly mode?: number;
}

/** A whole volume holding the files: the root is inode 2, directories and then files are numbered from 3. */
export function dumpOf(files: readonly TreeFile[]): Uint8Array {
  const directories = new Map<string, number>([["", 2]]);
  const children = new Map<string, Dirent[]>([["", []]]);
  let next = 3;
  const files3: { ino: number; file: TreeFile }[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let parent = "";
    for (const part of parts.slice(0, -1)) {
      const path = parent === "" ? part : `${parent}/${part}`;
      if (!directories.has(path)) {
        directories.set(path, next++);
        children.set(path, []);
        children.get(parent)!.push({ ino: directories.get(path)!, name: part });
      }
      parent = path;
    }
    const ino = next++;
    files3.push({ ino, file });
    children.get(parent)!.push({ ino, name: parts[parts.length - 1]! });
  }
  const records = prologue();
  for (const [path, ino] of directories) {
    const data = directoryData([{ ino, name: "." }, { ino: 2, name: ".." }, ...children.get(path)!]);
    records.push(...inode(ino, MODE.DIRECTORY, data));
  }
  for (const { ino, file } of files3) {
    records.push(...inode(ino, file.mode ?? MODE.FILE, file.data, { mtimeSeconds: file.mtimeSeconds ?? 0 }));
  }
  records.push(END_RECORD());
  return volume(records);
}
