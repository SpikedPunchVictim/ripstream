import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import {
  AbortError,
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  ParseTimeoutError,
  RipstreamInputStream,
  ToXMLContentHandler,
  WriteLimitReachedError,
  XHTMLContentHandler,
  type EmbeddedDocumentExtractor,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { UnixDumpParser } from "../src/index.ts";
import {
  END_RECORD,
  MODE,
  RECORD,
  SEGMENT,
  directoryData,
  dumpOf,
  header,
  inode,
  prologue,
  volume,
} from "./dump-builder.ts";

/*
 * The reader follows commons-compress's DumpArchiveInputStream, which Tika's PackageParser uses for
 * application/x-tika-unix-dump. That source is not in the Tika tree: the layout and the reading order are from memory,
 * and no real dump file was available, so these volumes are built by dump-builder.ts. None of this was run against a
 * Tika (tikajs-68os.47).
 */

interface Seen {
  readonly name: string | null;
  readonly bytes: Uint8Array;
  readonly metadata: Metadata;
}

function capturing(seen: Seen[]): Parser {
  return {
    getSupportedTypes: () => new Set(),
    async parse(stream, handler, metadata) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      seen.push({ name: metadata.get("tk:resource-name"), bytes: new Uint8Array(Buffer.concat(chunks)), metadata });
      const xhtml = new XHTMLContentHandler(handler, new Metadata());
      await xhtml.startDocument();
      await xhtml.endDocument();
    },
  };
}

interface Run {
  readonly seen: Seen[];
  readonly metadata: Metadata;
  readonly text: string;
}

interface RunOptions {
  /** Replaces the parser that embedded documents go to (default: one that records what it is given). */
  readonly parser?: Parser;
  /** Replaces ParsingEmbeddedDocumentExtractor, which charges its own byte and depth limits. */
  readonly extractor?: EmbeddedDocumentExtractor;
}

async function run(
  bytes: Uint8Array,
  limits: ConstructorParameters<typeof ParseContext>[0] = {},
  options: RunOptions = {},
): Promise<Run> {
  const seen: Seen[] = [];
  const context = new ParseContext(limits);
  context.set(CONTEXT_KEYS.PARSER, options.parser ?? capturing(seen));
  if (options.extractor !== undefined) context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, options.extractor);
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  try {
    await new UnixDumpParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { seen, metadata, text: handler.toString() };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

test("is named UnixDumpParser, the name tk:parsed-by carries", () => {
  assert.equal(new UnixDumpParser().name, "UnixDumpParser");
});

test("claims application/x-tika-unix-dump", () => {
  const types = [...new UnixDumpParser().getSupportedTypes()].map(String);
  assert.deepEqual(types, ["application/x-tika-unix-dump"]);
});

test("every file of the volume is an embedded document, named by its path from the root", async () => {
  const { seen } = await run(
    dumpOf([
      { path: "a.txt", data: text("hello a") },
      { path: "sub/b.txt", data: text("hello b") },
      { path: "sub/deeper/c.txt", data: text("hello c") },
    ]),
  );
  assert.deepEqual(
    seen.map((s) => [s.name, new TextDecoder().decode(s.bytes)]),
    [
      ["a.txt", "hello a"],
      ["sub/b.txt", "hello b"],
      ["sub/deeper/c.txt", "hello c"],
    ],
  );
});

test("directories are not embedded documents", async () => {
  const { seen } = await run(dumpOf([{ path: "sub/b.txt", data: text("b") }]));
  assert.equal(seen.length, 1);
});

test("the entry's metadata is its name, size and modification time (AbstractArchiveParser.handleEntryMetadata)", async () => {
  const { seen } = await run(dumpOf([{ path: "sub/b.txt", data: text("hello b"), mtimeSeconds: 1_600_000_000 }]));
  const metadata = seen[0]!.metadata;
  assert.equal(metadata.get("tk:internal-path"), "sub/b.txt");
  assert.equal(metadata.get("Content-Length"), "7");
  assert.equal(metadata.get("fs:modified"), "2020-09-13T12:26:40Z");
  assert.equal(metadata.get("fs:created"), null);
});

test("the container's Content-Type is the dump's, as PackageParser.updateMediaType sets it", async () => {
  const { metadata } = await run(dumpOf([{ path: "a.txt", data: text("x") }]));
  assert.equal(metadata.get("Content-Type"), "application/x-tika-unix-dump");
});

test("the output has a package-entry div with the name for each file", async () => {
  const { text: out } = await run(dumpOf([{ path: "a.txt", data: text("x") }]));
  assert.match(out, /a\.txt/);
});

test("a file of several blocks is read whole, the last block cut at the size", async () => {
  const data = new Uint8Array(3 * RECORD + 5).map((_, i) => i % 251);
  const { seen } = await run(dumpOf([{ path: "big.bin", data }]));
  assert.deepEqual(seen[0]!.bytes, data);
});

test("a file of more than 512 blocks continues in an ADDR segment", async () => {
  const data = new Uint8Array(600 * RECORD + 17).map((_, i) => (i * 7) % 253);
  const { seen } = await run(dumpOf([{ path: "big.bin", data }, { path: "after.txt", data: text("after") }]));
  assert.deepEqual(seen[0]!.bytes, data);
  assert.equal(new TextDecoder().decode(seen[1]!.bytes), "after");
});

test("a hole in the address map reads as zeros and has no block on the tape", async () => {
  const data = new Uint8Array(3 * RECORD).fill(7);
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "sparse" }, { ino: 4, name: "next" }])),
    ...inode(3, MODE.FILE, data, { holes: new Set([1]) }),
    ...inode(4, MODE.FILE, text("next")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  const expected = new Uint8Array(data);
  expected.fill(0, RECORD, 2 * RECORD);
  assert.deepEqual(seen[0]!.bytes, expected);
  assert.equal(new TextDecoder().decode(seen[1]!.bytes), "next");
});

test("a symbolic link is an embedded document holding its target, as PackageParser parses every non-directory", async () => {
  const { seen } = await run(dumpOf([{ path: "link", data: text("a.txt"), mode: MODE.LINK }]));
  assert.equal(new TextDecoder().decode(seen[0]!.bytes), "a.txt");
});

test("an inode no directory names is skipped, and the data after it is still read", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 4, name: "named" }])),
    ...inode(9, MODE.FILE, new Uint8Array(2 * RECORD).fill(1), { holes: new Set([0]) }),
    ...inode(4, MODE.FILE, text("named")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["named"]);
});

test("a name that would leave the archive root is skipped and recorded, as the ZIP reader does", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "../evil" }, { ino: 4, name: "ok" }])),
    ...inode(3, MODE.FILE, text("evil")),
    ...inode(4, MODE.FILE, text("ok")),
    END_RECORD(),
  ];
  const { seen, metadata } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["ok"]);
  assert.match(metadata.get("tk:exception:embedded-stream-exception") ?? "", /unsafe archive path skipped: \.\.\/evil/);
});

test("a volume with no files has no embedded documents", async () => {
  const { seen } = await run(volume([...prologue(), ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }])), END_RECORD()]));
  assert.deepEqual(seen, []);
});

test("a volume header whose checksum is wrong is refused", async () => {
  const bytes = dumpOf([{ path: "a", data: text("x") }]);
  bytes.set(header({ type: SEGMENT.TAPE, badChecksum: true }), 0);
  await assert.rejects(run(bytes), MalformedDocumentError);
});

test("a volume of the old magic number is refused", async () => {
  const bytes = dumpOf([{ path: "a", data: text("x") }]);
  bytes.set(header({ type: SEGMENT.TAPE, magic: 60011 }), 0);
  await assert.rejects(run(bytes), MalformedDocumentError);
});

test("a volume that says it has no records to the block is refused", async () => {
  const bytes = dumpOf([{ path: "a", data: text("x") }]);
  bytes.set(header({ type: SEGMENT.TAPE, ntrec: 0 }), 0);
  await assert.rejects(run(bytes), MalformedDocumentError);
});

test("a volume cut off in the middle of a file is refused", async () => {
  const bytes = dumpOf([{ path: "a.bin", data: new Uint8Array(4 * RECORD).fill(3) }]);
  // Records: volume header, CLRI + 1, BITS + 1, root header + 1, file header, then 4 blocks.
  const cut = bytes.subarray(0, (5 + 2 + 1 + 2) * RECORD);
  await assert.rejects(run(cut), MalformedDocumentError);
});

test("a volume with no end record is refused", async () => {
  const records = [...prologue(), ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }]))];
  await assert.rejects(run(volume(records).subarray(0, records.length * RECORD)), MalformedDocumentError);
});

test("a record that is not a header where one is due is refused", async () => {
  const records = [...prologue(), new Uint8Array(RECORD).fill(0x55), END_RECORD()];
  await assert.rejects(run(volume(records)), MalformedDocumentError);
});

test("a size over the per-entry limit is refused before any block is read", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "huge" }])),
    ...inode(3, MODE.FILE, new Uint8Array(0), { size: 2n ** 50n }),
    END_RECORD(),
  ];
  await assert.rejects(run(volume(records)), LimitExceededError);
});

test("a size beyond what a double holds is refused as over the limit, not allocated", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "huge" }])),
    ...inode(3, MODE.FILE, new Uint8Array(0), { size: 2n ** 62n }),
    END_RECORD(),
  ];
  await assert.rejects(run(volume(records)), LimitExceededError);
});

test("a negative size is refused", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "neg" }])),
    ...inode(3, MODE.FILE, new Uint8Array(0), { size: -5n }),
    END_RECORD(),
  ];
  await assert.rejects(run(volume(records)), MalformedDocumentError);
});

test("a file of holes that inflates past the ratio limit is refused", async () => {
  // 4 MB declared, every block a hole: eight headers (512 blocks each) for 4 MB of zeros.
  const size = 8 * 512 * RECORD;
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "holes" }])),
    header({ type: SEGMENT.INODE, ino: 3, mode: MODE.FILE, size, count: 512 }),
  ];
  for (let i = 1; i < 8; i++) records.push(header({ type: SEGMENT.ADDR, ino: 3, mode: MODE.FILE, size, count: 512 }));
  records.push(END_RECORD());
  await assert.rejects(run(volume(records), { limits: { maxDecompressionRatio: 100 } }), LimitExceededError);
});

test("an address count over 512 is refused", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "x" }])),
    header({ type: SEGMENT.INODE, ino: 3, mode: MODE.FILE, size: 10, count: 513 }),
    END_RECORD(),
  ];
  await assert.rejects(run(volume(records)), MalformedDocumentError);
});

test("more files than the entry limit is refused", async () => {
  const bytes = dumpOf([
    { path: "1", data: text("1") },
    { path: "2", data: text("2") },
    { path: "3", data: text("3") },
  ]);
  await assert.rejects(run(bytes, { limits: { maxZipEntries: 2 } }), LimitExceededError);
});

test("a directory entry of record length 0 is refused", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: ".", reclen: 0 }])),
    END_RECORD(),
  ];
  await assert.rejects(run(volume(records)), MalformedDocumentError);
});

test("a directory name that runs past its block is refused", async () => {
  const block = new Uint8Array(RECORD);
  const view = new DataView(block.buffer);
  view.setUint32(0, 2, true);
  view.setUint16(4, 1000, true);
  block[7] = 1;
  block[8] = 0x2e;
  view.setUint32(1000, 3, true);
  view.setUint16(1004, 24, true);
  block[1007] = 255;
  const inodeHeader = header({ type: SEGMENT.INODE, ino: 2, mode: MODE.DIRECTORY, size: RECORD, count: 1, present: [true] });
  await assert.rejects(run(volume([...prologue(), inodeHeader, block, END_RECORD()])), MalformedDocumentError);
});

test("directories that name each other and never reach the root are refused", async () => {
  const records = [
    ...prologue(),
    ...inode(3, MODE.DIRECTORY, directoryData([{ ino: 4, name: "d4" }, { ino: 6, name: "f" }])),
    ...inode(4, MODE.DIRECTORY, directoryData([{ ino: 3, name: "d3" }])),
    ...inode(6, MODE.FILE, text("x")),
    END_RECORD(),
  ];
  await assert.rejects(run(volume(records)), LimitExceededError);
});

test("a nested path past the node depth limit is refused", async () => {
  const depth = 5;
  const records = [...prologue()];
  const path = Array.from({ length: depth }, (_, i) => `d${i}`);
  records.push(...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: path[0]! }])));
  for (let i = 0; i < depth; i++) {
    const children = i + 1 < depth ? [{ ino: 4 + i, name: path[i + 1]! }] : [{ ino: 4 + i, name: "leaf" }];
    records.push(...inode(3 + i, MODE.DIRECTORY, directoryData(children)));
  }
  records.push(...inode(4 + depth - 1, MODE.FILE, text("x")), END_RECORD());
  await assert.rejects(run(volume(records), { limits: { maxNodeDepth: 3 } }), LimitExceededError);
});

test("an aborted parse stops", async () => {
  const controller = new AbortController();
  controller.abort();
  const context = new ParseContext({ signal: controller.signal });
  const stream = await RipstreamInputStream.from(dumpOf([{ path: "a", data: text("x") }]));
  try {
    await assert.rejects(new UnixDumpParser().parse(stream, new BodyContentHandler(), new Metadata(), context));
  } finally {
    await stream.close();
  }
});

/*
 * Mutation hardening. Each test below pins one constant or comparison of the reader. The layout it pins (the magic at
 * offset 24, the checksum at 28, the address map at 164, the flags at 888, ntrec at 896, segment types 1 to 6) is the
 * one dump-builder.ts defines, from memory of commons-compress: these tests keep the reader and the builder in step,
 * they do not show the layout is dump(8)'s.
 */

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Takes every embedded document without parsing it, so that only the dump reader's own limits apply. */
function recording(): EmbeddedDocumentExtractor & { readonly seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    shouldParseEmbedded: () => true,
    async parseEmbedded(stream, _handler, metadata) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      seen.push({ name: metadata.get("tk:resource-name"), bytes: new Uint8Array(Buffer.concat(chunks)), metadata });
    },
  };
}

/** One directory of `names` (inodes 3 and up, none of them on the tape) and nothing else. */
function directoryOnly(names: readonly string[]): Uint8Array {
  const entries = names.map((name, index) => ({ ino: 3 + index, name }));
  return volume([
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, ...entries])),
    END_RECORD(),
  ]);
}

/** A file of `size` bytes that is all holes, in as many headers as its blocks need. */
function holeVolume(size: number): Uint8Array {
  const blockTotal = Math.ceil(size / RECORD);
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "holes" }])),
  ];
  for (let start = 0; start < blockTotal; start += 512) {
    records.push(
      header({
        type: start === 0 ? SEGMENT.INODE : SEGMENT.ADDR,
        ino: 3,
        mode: MODE.FILE,
        size,
        count: Math.min(512, blockTotal - start),
      }),
    );
  }
  records.push(END_RECORD());
  return volume(records);
}

/** A path of `components` names from the root, the last one a file. */
function nested(components: number): Uint8Array {
  const path = Array.from({ length: components }, (_, i) => (i === components - 1 ? "leaf" : `d${i}`)).join("/");
  return dumpOf([{ path, data: text("x") }]);
}

test("every word of the volume header but the checksum's counts toward the checksum", async () => {
  for (let word = 0; word < RECORD / 4; word++) {
    if (word === 7) continue;
    const bytes = dumpOf([{ path: "a", data: text("x") }]);
    bytes[4 * word] = bytes[4 * word]! ^ 0x5a;
    await assert.rejects(run(bytes), MalformedDocumentError, `word ${word}`);
  }
});

test("the checksum field itself is compared, not skipped", async () => {
  const bytes = dumpOf([{ path: "a", data: text("x") }]);
  bytes[28] = bytes[28]! ^ 0x01;
  await assert.rejects(run(bytes), MalformedDocumentError);
});

test("a header whose words sum past 32 bits is still checked by the wrapped sum", async () => {
  // Words of 0x7fffffff overflow upwards; the second set leaves the unwrapped target 84446 - sum beyond 2^31.
  const fieldSets = [
    { ino: 0x7fffffff, mtimeSeconds: 0x7fffffff, mtimeNanoseconds: 0x7fffffff },
    { ino: 0x80000000, mtimeSeconds: -2147483648, mtimeNanoseconds: 447363088 },
  ];
  for (const fields of fieldSets) {
    const records = [
      ...prologue(fields),
      ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "a" }])),
      ...inode(3, MODE.FILE, text("x")),
      END_RECORD(),
    ];
    const { seen } = await run(volume(records));
    assert.deepEqual(seen.map((s) => s.name), ["a"], JSON.stringify(fields));
  }
});

test("an inode number is read as unsigned", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 0xfffffff0, name: "big" }])),
    ...inode(0xfffffff0, MODE.FILE, text("big")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["big"]);
});

test("flag bits other than the compressed one do not refuse the volume", async () => {
  const bytes = dumpOf([{ path: "a", data: text("x") }]);
  bytes.set(header({ type: SEGMENT.TAPE, flags: 0x0100 | 0x0040 | 0x0001 }), 0);
  const { seen } = await run(bytes);
  assert.equal(seen.length, 1);
});

test("a volume of one record to the block is read", async () => {
  const bytes = dumpOf([{ path: "a", data: text("x") }]);
  bytes.set(header({ type: SEGMENT.TAPE, ntrec: 1 }), 0);
  const { seen } = await run(bytes);
  assert.equal(seen.length, 1);
});

test("a volume cut in the middle of a record is truncated", async () => {
  const bytes = dumpOf([{ path: "a", data: text("x") }]);
  // 5 prologue records, root header + block, file header + block, END: 10 records.
  await assert.rejects(run(bytes.subarray(0, 9 * RECORD + 500)), /truncated/);
});

test("a volume that ends inside a map it must skip is truncated", async () => {
  const bytes = volume(prologue()).subarray(0, 2 * RECORD);
  await assert.rejects(run(bytes), (error: unknown) => error instanceof MalformedDocumentError && /truncated/.test(error.message));
});

test("the CLRI map must come before the BITS map", async () => {
  const records = [
    header({ type: SEGMENT.TAPE }),
    header({ type: SEGMENT.BITS, count: 1, present: [true] }),
    new Uint8Array(RECORD),
    header({ type: SEGMENT.CLRI, count: 1, present: [true] }),
    new Uint8Array(RECORD),
    END_RECORD(),
  ];
  await assert.rejects(run(volume(records)), /segment of type 6/);
});

test("the BITS map must come after the CLRI map", async () => {
  const records = [header({ type: SEGMENT.TAPE }), header({ type: SEGMENT.CLRI }), header({ type: SEGMENT.END })];
  await assert.rejects(run(volume(records)), /segment of type 3/);
});

test("a map of a negative block count is refused as such", async () => {
  const records = [header({ type: SEGMENT.TAPE }), header({ type: SEGMENT.CLRI, count: -1 }), END_RECORD()];
  await assert.rejects(run(volume(records)), /negative block count/);
});

test("maps of no blocks are skipped as nothing", async () => {
  const records = [
    header({ type: SEGMENT.TAPE }),
    header({ type: SEGMENT.CLRI }),
    header({ type: SEGMENT.BITS }),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "a" }])),
    ...inode(3, MODE.FILE, text("x")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["a"]);
});

test("a map's blocks are skipped whatever the address map says of them", async () => {
  const records = [
    header({ type: SEGMENT.TAPE }),
    header({ type: SEGMENT.CLRI, count: 3 }),
    new Uint8Array(RECORD),
    new Uint8Array(RECORD),
    new Uint8Array(RECORD),
    header({ type: SEGMENT.BITS, count: 2 }),
    new Uint8Array(RECORD),
    new Uint8Array(RECORD),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "a" }])),
    ...inode(3, MODE.FILE, text("x")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["a"]);
});

test("a block is on the tape when bit 0 of its address byte is set, a hole when it is not", async () => {
  const first = new Uint8Array(RECORD).fill(0x11);
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "bits" }, { ino: 4, name: "next" }])),
    header({ type: SEGMENT.INODE, ino: 3, mode: MODE.FILE, size: 2 * RECORD, count: 2, addresses: [3, 2] }),
    first,
    ...inode(4, MODE.FILE, text("next")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  const expected = new Uint8Array(2 * RECORD);
  expected.set(first);
  assert.deepEqual(seen[0]!.bytes, expected);
  assert.equal(decode(seen[1]!.bytes), "next");
});

test("only a directory's mode makes it a directory: devices, pipes and sockets are documents", async () => {
  const modes = [0o140755, 0o020644, 0o060644, 0o010644, 0o100000];
  const files = modes.map((mode, index) => ({ path: `f${index}`, data: text(`m${index}`), mode }));
  const { seen } = await run(dumpOf(files));
  assert.deepEqual(seen.map((s) => decode(s.bytes)), ["m0", "m1", "m2", "m3", "m4"]);
});

test("a file that is empty is an embedded document of no bytes", async () => {
  const { seen } = await run(dumpOf([{ path: "empty", data: new Uint8Array(0) }]));
  assert.equal(seen[0]!.name, "empty");
  assert.equal(seen[0]!.bytes.length, 0);
  assert.equal(seen[0]!.metadata.get("Content-Length"), "0");
});

test("a modification time past a second's worth of the nanosecond field moves the second, as commons-compress adds it", async () => {
  // 1000 * seconds + nanoseconds / 1000 milliseconds: 2_500_000 / 1000 is 2500 ms, two seconds and a half.
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "t" }])),
    ...inode(3, MODE.FILE, text("x"), { mtimeSeconds: 1_600_000_000, mtimeNanoseconds: 2_500_000 }),
    END_RECORD(),
  ];
  const second = await run(volume(records));
  assert.equal(second.seen[0]!.metadata.get("fs:modified"), "2020-09-13T12:26:42Z");
});

test("a negative nanosecond field is cut toward zero before it is added", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "t" }])),
    ...inode(3, MODE.FILE, text("x"), { mtimeSeconds: 1_600_000_000, mtimeNanoseconds: -500 }),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.equal(seen[0]!.metadata.get("fs:modified"), "2020-09-13T12:26:40Z");
});

test("the entry's metadata carries its name under both keys and no other time", async () => {
  const { seen } = await run(dumpOf([{ path: "sub/b.txt", data: text("hello b") }]));
  const metadata = seen[0]!.metadata;
  assert.equal(metadata.get("tk:resource-name"), "sub/b.txt");
  assert.equal(metadata.get("tk:internal-path"), "sub/b.txt");
  assert.equal(metadata.get("fs:created"), null);
});

test("the name has backslashes read as separators", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "a\\b.txt" }])),
    ...inode(3, MODE.FILE, text("x")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["a/b.txt"]);
});

test("the output marks each file with an empty embedded div and a package-entry div holding its name", async () => {
  const handler = new ToXMLContentHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.PARSER, capturing([]));
  const stream = await RipstreamInputStream.from(dumpOf([{ path: "a.txt", data: text("x") }]));
  try {
    await new UnixDumpParser().parse(stream, handler, new Metadata(), context);
  } finally {
    await stream.close();
  }
  const xml = handler.toString();
  assert.match(xml, /<div class="embedded" id="a\.txt"\s*\/>|<div class="embedded" id="a\.txt"><\/div>/);
  assert.match(xml, /<div class="package-entry"><h1>a\.txt<\/h1>\s*<\/div>/);
});

test("an extractor that declines the document gets no stream and leaves no package-entry div", async () => {
  const handler = new ToXMLContentHandler();
  const context = new ParseContext();
  const asked: string[] = [];
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, {
    shouldParseEmbedded: (metadata: Metadata) => {
      asked.push(metadata.get("tk:resource-name") ?? "");
      return false;
    },
    parseEmbedded: async () => {
      throw new Error("must not be asked to parse");
    },
  } satisfies EmbeddedDocumentExtractor);
  const stream = await RipstreamInputStream.from(dumpOf([{ path: "a.txt", data: text("x") }]));
  try {
    await new UnixDumpParser().parse(stream, handler, new Metadata(), context);
  } finally {
    await stream.close();
  }
  assert.deepEqual(asked, ["a.txt"]);
  assert.match(handler.toString(), /class="embedded"/);
  assert.doesNotMatch(handler.toString(), /package-entry/);
});

test("an embedded parse that fails is recorded and the next file is still read", async () => {
  const failing: Parser = {
    getSupportedTypes: () => new Set(),
    async parse() {
      throw new Error("boom");
    },
  };
  const { metadata } = await run(dumpOf([{ path: "a", data: text("1") }, { path: "b", data: text("2") }]), {}, { parser: failing });
  assert.deepEqual(metadata.getAll("tk:exception:embedded-stream-exception"), ["Error: boom", "Error: boom"]);
});

test("an embedded parse that fails with no message is recorded with its name and a colon", async () => {
  const failing: Parser = {
    getSupportedTypes: () => new Set(),
    async parse() {
      throw new Error("");
    },
  };
  const { metadata } = await run(dumpOf([{ path: "a", data: text("1") }]), {}, { parser: failing });
  assert.deepEqual(metadata.getAll("tk:exception:embedded-stream-exception"), ["Error: "]);
});

test("an embedded parse that throws something that is not an Error is recorded as text", async () => {
  const failing: Parser = {
    getSupportedTypes: () => new Set(),
    async parse() {
      throw "plain text";
    },
  };
  const { metadata } = await run(dumpOf([{ path: "a", data: text("1") }]), {}, { parser: failing });
  assert.deepEqual(metadata.getAll("tk:exception:embedded-stream-exception"), ["plain text"]);
});

for (const [label, error] of [
  ["a limit", new LimitExceededError("too much")],
  ["a timeout", new ParseTimeoutError("too slow")],
  ["an abort", new AbortError("stop")],
  ["the output cut", new WriteLimitReachedError(10)],
] as const) {
  test(`${label} inside an embedded parse ends the whole parse`, async () => {
    const failing: Parser = {
      getSupportedTypes: () => new Set(),
      async parse() {
        throw error;
      },
    };
    await assert.rejects(run(dumpOf([{ path: "a", data: text("1") }]), {}, { parser: failing }), (thrown: unknown) => thrown === error);
  });
}

test("any failure inside an embedded parse ends the whole parse once the parse is aborted", async () => {
  const controller = new AbortController();
  const failing: Parser = {
    getSupportedTypes: () => new Set(),
    async parse() {
      controller.abort();
      throw new Error("after the abort");
    },
  };
  await assert.rejects(
    run(dumpOf([{ path: "a", data: text("1") }]), { signal: controller.signal }, { parser: failing }),
    (thrown: unknown) => thrown instanceof Error && /after the abort/.test(thrown.message),
  );
});

test("the stream handed to an embedded parse is closed when the parse is over", async () => {
  const events: string[] = [];
  const extractor: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: () => true,
    async parseEmbedded(stream) {
      const close = stream.close.bind(stream);
      stream.close = async () => {
        events.push("closed");
        await close();
      };
      events.push("parsed");
    },
  };
  await run(dumpOf([{ path: "a", data: text("1") }]), {}, { extractor });
  assert.deepEqual(events, ["parsed", "closed"]);
});

test("the stream is closed when the embedded parse fails too", async () => {
  const events: string[] = [];
  const extractor: EmbeddedDocumentExtractor = {
    shouldParseEmbedded: () => true,
    async parseEmbedded(stream) {
      const close = stream.close.bind(stream);
      stream.close = async () => {
        events.push("closed");
        await close();
      };
      throw new Error("boom");
    },
  };
  await run(dumpOf([{ path: "a", data: text("1") }]), {}, { extractor });
  assert.deepEqual(events, ["closed"]);
});

test("an abort that comes between two records stops the read at the next one", async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  const parser: Parser = {
    getSupportedTypes: () => new Set(),
    async parse(_stream, _handler, metadata) {
      seen.push(metadata.get("tk:resource-name") ?? "");
      controller.abort();
    },
  };
  await assert.rejects(
    run(dumpOf([{ path: "a", data: text("1") }, { path: "b", data: text("2") }]), { signal: controller.signal }, { parser }),
  );
  assert.deepEqual(seen, ["a"]);
});

test("skipping blocks checks for an abort before the cursor moves", async () => {
  const controller = new AbortController();
  const stream = await RipstreamInputStream.from(dumpOf([{ path: "a", data: text("x") }]));
  let reads = 0;
  let seeks = 0;
  const peek = stream.peek.bind(stream);
  const seek = stream.seek.bind(stream);
  stream.peek = async (count) => {
    const record = await peek(count);
    // The abort lands as the CLRI header is read: the next thing the parser does is skip the CLRI map.
    if (++reads === 2) controller.abort();
    return record;
  };
  stream.seek = async (offset, whence) => {
    seeks++;
    return seek(offset, whence);
  };
  try {
    await assert.rejects(
      new UnixDumpParser().parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext({ signal: controller.signal })),
    );
  } finally {
    await stream.close();
  }
  // Two records read (each moves the cursor once) and no move for the CLRI map.
  assert.equal(seeks, 2);
});

test("an inode that no directory names is skipped with every block it has on the tape, and its ADDR segments", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 4, name: "named" }])),
    ...inode(9, MODE.FILE, new Uint8Array(2 * RECORD).fill(1)),
    ...inode(10, MODE.FILE, new Uint8Array(600 * RECORD).fill(2)),
    ...inode(4, MODE.FILE, text("named")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["named"]);
});

test("a named file with blocks left unread when its size is reached has them skipped from where it stopped", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "short" }, { ino: 4, name: "next" }])),
    ...inode(3, MODE.FILE, new Uint8Array(3 * RECORD).fill(6), { size: RECORD + 1 }),
    ...inode(4, MODE.FILE, text("next")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.equal(seen[0]!.bytes.length, RECORD + 1);
  assert.equal(decode(seen[1]!.bytes), "next");
});

test("a segment of a type that is neither inode nor ADDR is skipped with its blocks", async () => {
  for (const type of [SEGMENT.BITS, SEGMENT.CLRI, SEGMENT.TAPE]) {
    const records = [
      ...prologue(),
      ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "a" }])),
      header({ type, count: 2, present: [true, true] }),
      new Uint8Array(RECORD),
      new Uint8Array(RECORD),
      ...inode(3, MODE.FILE, text("x")),
      END_RECORD(),
    ];
    const { seen } = await run(volume(records));
    assert.deepEqual(seen.map((s) => s.name), ["a"], `type ${type}`);
  }
});

test("an unsafe path's blocks are skipped and the file after it is read", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "../evil" }, { ino: 4, name: "ok" }])),
    ...inode(3, MODE.FILE, new Uint8Array(2 * RECORD).fill(9)),
    ...inode(4, MODE.FILE, text("ok")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => decode(s.bytes)), ["ok"]);
});

test("a file in a directory that was never read has no path and is skipped", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 7, name: "seven" }])),
    // Directory 4 is named by nobody that was read, so its file has no path.
    ...inode(4, MODE.DIRECTORY, directoryData([{ ino: 6, name: "orphan" }])),
    ...inode(6, MODE.FILE, text("orphan")),
    ...inode(7, MODE.FILE, text("seven")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["seven"]);
});

test("a directory entry that ends exactly at the end of its block is read", async () => {
  const block = new Uint8Array(RECORD);
  const view = new DataView(block.buffer);
  view.setUint32(0, 2, true);
  view.setUint16(4, 1000, true);
  block[7] = 1;
  block[8] = 0x2e;
  view.setUint32(1000, 3, true);
  view.setUint16(1004, 24, true);
  block[1007] = 16;
  block.set(text("abcdefghijklmnop"), 1008);
  const records = [
    ...prologue(),
    header({ type: SEGMENT.INODE, ino: 2, mode: MODE.DIRECTORY, size: RECORD, count: 1, present: [true] }),
    block,
    ...inode(3, MODE.FILE, text("x")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["abcdefghijklmnop"]);
});

/** A directory block whose first entry reaches `start` and whose second entry (inode 3) starts there. */
function blockWithEntryAt(start: number, name: string): Uint8Array {
  const block = new Uint8Array(RECORD);
  const view = new DataView(block.buffer);
  view.setUint32(0, 2, true);
  view.setUint16(4, start, true);
  block[7] = 1;
  block[8] = 0x2e;
  view.setUint32(start, 3, true);
  view.setUint16(start + 4, RECORD - start, true);
  block[start + 7] = name.length;
  block.set(text(name), start + 8);
  return block;
}

test("an entry that starts 9 bytes before the end of its block is read", async () => {
  const records = [
    ...prologue(),
    header({ type: SEGMENT.INODE, ino: 2, mode: MODE.DIRECTORY, size: RECORD, count: 1, present: [true] }),
    blockWithEntryAt(1015, "z"),
    ...inode(3, MODE.FILE, text("x")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["z"]);
});

test("an entry that starts in the last 8 bytes of its block is not read", async () => {
  const records = [
    ...prologue(),
    // The size is larger than the block, so that only the block ends the read.
    header({ type: SEGMENT.INODE, ino: 2, mode: MODE.DIRECTORY, size: 2 * RECORD, count: 1, present: [true] }),
    blockWithEntryAt(1016, ""),
    ...inode(3, MODE.FILE, text("x")),
    END_RECORD(),
  ];
  const { seen, metadata } = await run(volume(records));
  assert.deepEqual(seen, []);
  assert.equal(metadata.get("tk:exception:embedded-stream-exception"), null);
});

test("a directory's entries are read up to 8 bytes short of its declared size, not of its block", async () => {
  const data = directoryData([{ ino: 2, name: "." }, { ino: 3, name: "a" }, { ino: 4, name: "b" }]);
  const volumeWith = (size: number): Uint8Array =>
    volume([
      ...prologue(),
      ...inode(2, MODE.DIRECTORY, data, { size }),
      ...inode(3, MODE.FILE, text("a")),
      ...inode(4, MODE.FILE, text("b")),
      END_RECORD(),
    ]);
  // The entries start at 0, 12 and 24: "b" is read when 24 < size - 8, that is from a size of 33.
  assert.deepEqual((await run(volumeWith(32))).seen.map((s) => s.name), ["a"]);
  assert.deepEqual((await run(volumeWith(33))).seen.map((s) => s.name), ["a", "b"]);
});

/** A directory of 513 blocks, so that its inode is followed by an ADDR segment: "a" in the first block, "late" in the last. */
function bigDirectory(size?: number): Uint8Array {
  const filler = directoryData([{ ino: 0, name: "" }]);
  const parts = [directoryData([{ ino: 2, name: "." }, { ino: 3, name: "a" }])];
  for (let block = 1; block < 512; block++) parts.push(filler);
  parts.push(directoryData([{ ino: 4, name: "late" }]));
  const data = new Uint8Array(513 * RECORD);
  parts.forEach((part, index) => data.set(part, index * RECORD));
  return volume([
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, data, size === undefined ? {} : { size }),
    ...inode(3, MODE.FILE, text("a")),
    ...inode(4, MODE.FILE, text("late")),
    END_RECORD(),
  ]);
}

test("a directory of more than 512 blocks goes on in its ADDR segment", async () => {
  const { seen } = await run(bigDirectory());
  assert.deepEqual(seen.map((s) => s.name), ["a", "late"]);
});

test("a directory's ADDR segment is read only while the size it declares has not run out", async () => {
  // commons-compress takes 1024 off the size per segment: a size of 1000 is spent by the second one.
  const { seen } = await run(bigDirectory(1000));
  assert.deepEqual(seen.map((s) => s.name), ["a"]);
});

test("a directory names the entries under its own inode", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "one" }, { ino: 4, name: "two" }])),
    ...inode(3, MODE.DIRECTORY, directoryData([{ ino: 3, name: "." }, { ino: 2, name: ".." }, { ino: 5, name: "x" }])),
    ...inode(4, MODE.DIRECTORY, directoryData([{ ino: 4, name: "." }, { ino: 2, name: ".." }, { ino: 6, name: "x" }])),
    ...inode(5, MODE.FILE, text("under one")),
    ...inode(6, MODE.FILE, text("under two")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => [s.name, decode(s.bytes)]), [
    ["one/x", "under one"],
    ["two/x", "under two"],
  ]);
});

test("a file whose declared size is the per-entry limit is read, one byte over it is refused", async () => {
  // The root directory is one block, so the limit stays above 1024.
  const bytes = dumpOf([{ path: "a", data: new Uint8Array(2000).fill(1) }]);
  const extractor = recording();
  await run(bytes, { limits: { maxEmbeddedResourceBytes: 2000 } }, { extractor });
  assert.equal(extractor.seen[0]!.bytes.length, 2000);
  await assert.rejects(run(bytes, { limits: { maxEmbeddedResourceBytes: 1999 } }, { extractor: recording() }), LimitExceededError);
});

test("the total of the files is limited, a total of exactly the limit is read", async () => {
  const bytes = dumpOf([{ path: "a", data: new Uint8Array(10) }, { path: "b", data: new Uint8Array(10) }]);
  const extractor = recording();
  await run(bytes, { limits: { maxTotalEmbeddedBytes: 20 } }, { extractor });
  assert.equal(extractor.seen.length, 2);
  await assert.rejects(run(bytes, { limits: { maxTotalEmbeddedBytes: 19 } }, { extractor: recording() }), LimitExceededError);
});

test("an inode written twice is two entries against the entry limit", async () => {
  const records = (copies: number): Uint8Array =>
    volume([
      ...prologue(),
      ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "dup" }])),
      ...Array.from({ length: copies }, () => inode(3, MODE.FILE, text("x"))).flat(),
      END_RECORD(),
    ]);
  const extractor = recording();
  await run(records(2), { limits: { maxZipEntries: 2 } }, { extractor });
  assert.equal(extractor.seen.length, 2);
  await assert.rejects(run(records(3), { limits: { maxZipEntries: 2 } }, { extractor: recording() }), LimitExceededError);
});

test("as many directory entries as the entry limit are read, one more is refused before any file is", async () => {
  await run(directoryOnly(["a", "b"]), { limits: { maxZipEntries: 2 } });
  await assert.rejects(run(directoryOnly(["a", "b", "c"]), { limits: { maxZipEntries: 2 } }), LimitExceededError);
});

test("a path of as many names as the depth limit is read, one more is refused", async () => {
  const extractor = recording();
  await run(nested(3), { limits: { maxNodeDepth: 3 } }, { extractor });
  assert.deepEqual(extractor.seen.map((s) => s.name), ["d0/d1/leaf"]);
  await assert.rejects(run(nested(4), { limits: { maxNodeDepth: 3 } }, { extractor: recording() }), LimitExceededError);
});

test("a file of holes is read whole up to 1,000,000 bytes and refused as soon as it is past them", async () => {
  const extractor = recording();
  // The ratio limit is Tika's 1000 by default; this test pins the 1,000,000-byte ratio-check threshold with a limit of 100.
  const limits = { maxDecompressionRatio: 100 };
  await run(holeVolume(1_000_000), { limits }, { extractor });
  assert.equal(extractor.seen[0]!.bytes.length, 1_000_000);
  await assert.rejects(run(holeVolume(1_000_001), { limits }, { extractor: recording() }), LimitExceededError);
});

test("the ratio of a file to the records it takes is its bytes over 1024 for the inode, 1024 per ADDR header and per block", async () => {
  // 1000 hole blocks take two headers: the ratio is 1,024,000 / 2048 = 500, which is not over a limit of 500.
  const extractor = recording();
  await run(holeVolume(1000 * RECORD), { limits: { maxDecompressionRatio: 500 } }, { extractor });
  assert.equal(extractor.seen[0]!.bytes.length, 1000 * RECORD);
  await assert.rejects(
    run(holeVolume(1001 * RECORD), { limits: { maxDecompressionRatio: 500 } }, { extractor: recording() }),
    LimitExceededError,
  );
});

test("a file of over a megabyte that is all on the tape is not mistaken for holes", async () => {
  const data = new Uint8Array(1_500_000).map((_, i) => i % 251);
  const { seen } = await run(dumpOf([{ path: "big.bin", data }]));
  assert.deepEqual(seen[0]!.bytes, data);
});

test("a segment of a negative block count is refused where its blocks would be skipped", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }])),
    header({ type: SEGMENT.INODE, ino: 9, mode: MODE.FILE, size: 10, count: -1 }),
    END_RECORD(),
  ];
  await assert.rejects(run(volume(records)), /segment of -1 blocks/);
});

test("a directory that names itself is where its own paths start, and is not followed round", async () => {
  const records = [
    ...prologue(),
    ...inode(2, MODE.DIRECTORY, directoryData([{ ino: 2, name: "." }, { ino: 3, name: "d" }])),
    ...inode(3, MODE.DIRECTORY, directoryData([{ ino: 3, name: "self" }, { ino: 4, name: "f" }])),
    ...inode(4, MODE.FILE, text("x")),
    END_RECORD(),
  ];
  const { seen } = await run(volume(records));
  assert.deepEqual(seen.map((s) => s.name), ["self/f"]);
});

test("a real dump(8) volume from commons-compress parses, and its compressed encoding is read", async () => {
  const real = new Uint8Array(readFileSync(new URL("./fixtures/dump/commons-bla.dump", import.meta.url)));
  const plain = await run(real);
  assert.ok(plain.seen.length > 0);
  const compressed = compressDump(real);
  const packed = await run(compressed);
  assert.deepEqual(
    packed.seen.map((entry) => [entry.name, entry.bytes.length]),
    plain.seen.map((entry) => [entry.name, entry.bytes.length]),
  );
});

/** Re-encode a real uncompressed volume in TapeInputStream's compressed form: first tape block raw, then zlib blocks. */
function compressDump(source: Uint8Array): Uint8Array {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const blockSize = view.getInt32(896, true) * RECORD;
  // The first tape block is header + the rest raw; every later block gets a 4-byte header.
  const parts: Uint8Array[] = [source.subarray(0, blockSize)];
  for (let offset = blockSize; offset < source.length; offset += blockSize) {
    const block = source.subarray(offset, Math.min(offset + blockSize, source.length));
    const packed = new Uint8Array(deflateSync(block));
    if (packed.length < block.length) {
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, ((packed.length << 4) | 1) >>> 0, true);
      parts.push(header, packed);
    } else {
      const header = new Uint8Array(4);
      parts.push(header, block);
    }
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  // Mark the volume compressed and repair the header checksum over the changed flags word.
  const outView = new DataView(out.buffer);
  outView.setInt32(888, outView.getInt32(888, true) | 0x80, true);
  let sum = 0;
  for (let word = 0; word < RECORD / 4; word++) sum = (sum + outView.getInt32(4 * word, true)) | 0;
  const others = (sum - outView.getInt32(28, true)) | 0;
  outView.setInt32(28, (84446 - others) | 0, true);
  return out;
}
