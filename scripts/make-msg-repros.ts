/*
 * Writes the small Outlook .msg files of the repro fixtures in packages/parsers/test/fixtures/repros (tikajs-8vzf):
 *   node scripts/make-msg-repros.ts [out-dir]
 * A compound-file (OLE2 v3) writer with nested storages and a mini stream, and a few MAPI substream helpers. Every file is a few
 * KB of synthetic text; none holds a third-party byte. The expected texts in the fixtures were read off Apache Tika 4.2.0.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;

interface Node {
  name: string;
  data?: Uint8Array;
  children?: Node[];
  type?: number;
  index?: number;
  left?: number;
  right?: number;
  child?: number;
  start?: number;
  miniStart?: number;
}

/** CFB directory order: shorter names first, then by upper-cased code unit. */
function compare(a: Node, b: Node): number {
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  const x = a.name.toUpperCase();
  const y = b.name.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export function buildCfb(rootChildren: Node[]): Uint8Array {
  const root: Node = { name: "Root Entry", type: 5, children: rootChildren, index: 0 };
  const entries: Node[] = [root];
  const link = (parent: Node): void => {
    const kids = [...(parent.children ?? [])].sort(compare);
    for (const kid of kids) {
      kid.type = kid.children === undefined ? 2 : 1;
      entries.push(kid);
      kid.index = entries.length - 1;
    }
    const balance = (low: number, high: number): number => {
      if (low > high) return FREE;
      const mid = (low + high) >> 1;
      const node = kids[mid]!;
      node.left = balance(low, mid - 1);
      node.right = balance(mid + 1, high);
      return node.index!;
    };
    parent.child = balance(0, kids.length - 1);
    for (const kid of kids) if (kid.children !== undefined) link(kid);
  };
  link(root);

  const big = entries.filter((entry) => entry.type === 2 && entry.data!.length >= CUTOFF);
  const small = entries.filter((entry) => entry.type === 2 && entry.data!.length < CUTOFF);

  let miniLength = 0;
  const miniFat: number[] = [];
  for (const entry of small) {
    entry.miniStart = miniLength / MINI;
    miniLength += Math.ceil(entry.data!.length / MINI) * MINI;
  }
  const mini = new Uint8Array(miniLength);
  for (const entry of small) {
    mini.set(entry.data!, entry.miniStart! * MINI);
    const count = Math.ceil(entry.data!.length / MINI);
    if (count === 0) {
      entry.miniStart = END;
      continue;
    }
    for (let index = 0; index < count; index++) {
      miniFat[entry.miniStart! + index] = index === count - 1 ? END : entry.miniStart! + index + 1;
    }
  }

  const sectorsFor = (length: number): number => Math.ceil(length / SECTOR);
  const miniFatSectors = sectorsFor(miniFat.length * 4);
  const directorySectors = sectorsFor(entries.length * 128);
  const bigCounts = big.map((entry) => sectorsFor(entry.data!.length));
  const miniStreamSectors = sectorsFor(mini.length);
  const withoutFat = bigCounts.reduce((sum, count) => sum + count, 0) + miniStreamSectors + miniFatSectors + directorySectors;
  let fatSectors = 1;
  while (fatSectors * 128 < withoutFat + fatSectors) fatSectors++;
  if (fatSectors > 109) throw new Error("the file needs a DIFAT: too big for this writer");
  const total = withoutFat + fatSectors;

  const out = new Uint8Array(SECTOR + total * SECTOR);
  const view = new DataView(out.buffer);
  const fat: number[] = new Array(total).fill(FREE);
  let cursor = 0;
  const allocate = (count: number): number => {
    const first = cursor;
    for (let index = 0; index < count; index++) fat[first + index] = index === count - 1 ? END : first + index + 1;
    cursor += count;
    return count === 0 ? END : first;
  };
  const place = (sector: number, bytes: Uint8Array): void => out.set(bytes, SECTOR + sector * SECTOR);

  big.forEach((entry, index) => {
    entry.start = allocate(bigCounts[index]!);
    place(entry.start, entry.data!);
  });
  const miniStreamStart = allocate(miniStreamSectors);
  place(miniStreamStart, mini);
  const miniFatStart = allocate(miniFatSectors);
  const miniFatBytes = new Uint8Array(miniFatSectors * SECTOR).fill(0xff);
  const miniFatView = new DataView(miniFatBytes.buffer);
  miniFat.forEach((value, index) => miniFatView.setUint32(index * 4, value, true));
  place(miniFatStart, miniFatBytes);
  const directoryStart = allocate(directorySectors);
  const fatStart = cursor;
  for (let index = 0; index < fatSectors; index++) fat[cursor++] = FAT_SECTOR;

  const directory = new Uint8Array(directorySectors * SECTOR);
  const directoryView = new DataView(directory.buffer);
  entries.forEach((entry, index) => {
    const offset = index * 128;
    for (let char = 0; char < entry.name.length; char++) directoryView.setUint16(offset + char * 2, entry.name.charCodeAt(char), true);
    directoryView.setUint16(offset + 64, (entry.name.length + 1) * 2, true);
    directory[offset + 66] = entry.type!;
    directory[offset + 67] = 1;
    directoryView.setUint32(offset + 68, entry.left ?? FREE, true);
    directoryView.setUint32(offset + 72, entry.right ?? FREE, true);
    directoryView.setUint32(offset + 76, entry.type === 2 ? FREE : (entry.child ?? FREE), true);
    let start = 0;
    let size = 0;
    if (entry.type === 5) {
      start = mini.length > 0 ? miniStreamStart : END;
      size = mini.length;
    } else if (entry.type === 2) {
      size = entry.data!.length;
      start = size >= CUTOFF ? entry.start! : entry.miniStart!;
      if (size === 0) start = 0;
    }
    directoryView.setUint32(offset + 116, start, true);
    directoryView.setUint32(offset + 120, size, true);
  });
  place(directoryStart, directory);
  const fatBytes = new Uint8Array(fatSectors * SECTOR).fill(0xff);
  const fatView = new DataView(fatBytes.buffer);
  fat.forEach((value, index) => fatView.setUint32(index * 4, value, true));
  place(fatStart, fatBytes);

  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, directoryStart, true);
  view.setUint32(56, CUTOFF, true);
  view.setUint32(60, miniFatSectors > 0 ? miniFatStart : END, true);
  view.setUint32(64, miniFatSectors, true);
  view.setUint32(68, END, true);
  view.setUint32(72, 0, true);
  for (let index = 0; index < 109; index++) view.setUint32(76 + index * 4, index < fatSectors ? fatStart + index : FREE, true);
  return out;
}

const utf16 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    bytes[index * 2] = text.charCodeAt(index) & 0xff;
    bytes[index * 2 + 1] = text.charCodeAt(index) >> 8;
  }
  return bytes;
};
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const unicode = (tag: string, text: string): Node => ({ name: `__substg1.0_${tag}001F`, data: utf16(text) });
const binary = (tag: string, bytes: Uint8Array): Node => ({ name: `__substg1.0_${tag}0102`, data: bytes });

/** A message: the top-level substreams, then each attachment's as an `__attach_version1.0_#n` storage. */
function message(streams: Node[], attachments: Node[][] = []): Uint8Array {
  const kids: Node[] = [{ name: "__properties_version1.0", data: new Uint8Array(32) }, ...streams];
  attachments.forEach((attachment, index) => {
    kids.push({
      name: `__attach_version1.0_#${String(index).padStart(8, "0")}`,
      children: [{ name: "__properties_version1.0", data: new Uint8Array(8) }, ...attachment],
    });
  });
  return buildCfb(kids);
}

/** PR_RTF_COMPRESSED holding the raw bytes ("MELA"): the compressed size, the raw size, the type and a CRC the readers ignore. */
function uncompressedRtf(rtf: string): Uint8Array {
  const raw = Buffer.from(rtf, "latin1");
  const header = Buffer.alloc(16);
  header.writeUInt32LE(raw.length + 12, 0);
  header.writeUInt32LE(raw.length, 4);
  header.write("MELA", 8, "latin1");
  return Buffer.concat([header, raw]);
}

// The example of MS-OXRTFCP: "{\rtf1\ansi\ansicpg1252\pard hello world}\r\n" compressed with LZFu (it refers back into the
// 207-byte dictionary the format starts with).
const LZFU_HELLO_WORLD = Buffer.from(
  "2d000000 2b000000 4c5a4675 f1c5c7a7 03000a00 72637067 31323542 320af320 68656c09 00206277 05b06c64 7d0a800f a0".replaceAll(" ", ""),
  "hex",
);

const attachment = (options: { long?: string; display?: string; short?: string; mime?: string; data?: string }): Node[] => [
  ...(options.long === undefined ? [] : [unicode("3707", options.long)]),
  ...(options.display === undefined ? [] : [unicode("3001", options.display)]),
  ...(options.short === undefined ? [] : [unicode("3704", options.short)]),
  ...(options.mime === undefined ? [] : [unicode("370E", options.mime)]),
  ...(options.data === undefined ? [] : [binary("3701", utf8(options.data))]),
];

const base: Node[] = [unicode("001A", "IPM.Note"), unicode("0037", "Subj")];

const FILES: Record<string, Uint8Array> = {
  // The body is only in PR_HTML (0x1013), a fragment: no PR_BODY. The case of the corpus's simple_msg.msg.
  "msg-html-body-only.msg": message([...base, binary("1013", utf8("<p>html body</p>"))]),
  // PR_BODY and PR_HTML both: Tika writes the HTML.
  "msg-html-wins-over-text.msg": message([...base, unicode("1000", "plain body"), binary("1013", utf8("<p>html body</p>"))]),
  // PR_BODY alone: one paragraph, its line breaks kept.
  "msg-text-body.msg": message([...base, unicode("1000", "line one\r\n\r\nline  three\n  indented")]),
  // Compressed RTF (LZFu) alone.
  "msg-rtf-lzfu-body.msg": message([...base, binary("1009", LZFU_HELLO_WORLD)]),
  // RTF stored raw ("MELA"), no PR_BODY or PR_HTML: the case of the corpus's fake-encrypted.msg.
  "msg-rtf-mela-body.msg": message([...base, binary("1009", uncompressedRtf("{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Arial;}}\\pard Hello\\par World}"))]),
  // Two attachments with data and one without; the second is named by its display name.
  "msg-attachments.msg": message(
    [...base, binary("1013", utf8("<p>html body</p>"))],
    [
      attachment({ long: "a.txt", short: "A.TXT", mime: "text/plain", data: "first text" }),
      attachment({ display: "Display", short: "SHORT.TXT", mime: "text/plain", data: "second text" }),
      attachment({ long: "empty.bin", mime: "application/octet-stream" }),
    ],
  ),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../packages/parsers/test/fixtures/repros");
  mkdirSync(out, { recursive: true });
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(out, name), bytes);
}
