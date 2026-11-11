import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_KEYS,
  EmbeddedDocumentBytesHandler,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  TIKA_KEYS,
  UnsupportedFormatError,
  createOutputHandler,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
} from "@spikedpunch/ripstream-core";
import { TIKA_PARSER_TYPES } from "../src/generated/tika-parser-types.ts";
import { UniversalExecutableParser, createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * UniversalExecutableParser is ported from Tika 4.2.0's UniversalExecutableParser.java. The expectations are what that
 * source does when read, and what UniversalExecutableParserTest asserts (on the file under fixtures/executable/);
 * none of this was run against a Tika, which is not available here.
 */

const fixture = (name: string): Uint8Array => readFileSync(fileURLToPath(new URL(`./fixtures/executable/${name}`, import.meta.url)));

// ---- a fat file, assembled byte by byte ----

interface Entry {
  /** Written signed, in the width of the file: a hostile value is given as the negative it reads as. */
  readonly offset: number | bigint;
  readonly size: number | bigint;
}

interface FatOptions {
  readonly little?: boolean;
  readonly wide?: boolean;
  /** The count the header declares; the number of entries by default. */
  readonly count?: number;
  readonly entries: readonly Entry[];
  /** Bytes placed at an offset of the file, where an entry points. */
  readonly place?: ReadonlyArray<readonly [number, Uint8Array]>;
  /** The least length of the file. */
  readonly length?: number;
}

function fat(options: FatOptions): Uint8Array {
  const little = options.little ?? false;
  const wide = options.wide ?? false;
  const entrySize = wide ? 32 : 20;
  const tableEnd = 8 + options.entries.length * entrySize;
  const placed = options.place ?? [];
  const length = Math.max(options.length ?? 0, tableEnd, ...placed.map(([offset, bytes]) => offset + bytes.length));
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  // fat_header.magic is 0xCAFEBABE (0xCAFEBABF for the 64-bit fat_arch_64), and the other byte order is its reverse.
  const magic = wide ? [0xca, 0xfe, 0xba, 0xbf] : [0xca, 0xfe, 0xba, 0xbe];
  bytes.set(little ? magic.reverse() : magic, 0);
  view.setInt32(4, options.count ?? options.entries.length, little);
  options.entries.forEach((entry, index) => {
    const at = 8 + index * entrySize;
    view.setUint32(at, 0x01000007, little); // cputype
    view.setUint32(at + 4, 3, little); // cpusubtype
    if (wide) {
      view.setBigInt64(at + 8, BigInt(entry.offset), little);
      view.setBigInt64(at + 16, BigInt(entry.size), little);
      view.setUint32(at + 24, 12, little); // align
    } else {
      view.setInt32(at + 8, Number(entry.offset), little);
      view.setInt32(at + 12, Number(entry.size), little);
      view.setUint32(at + 16, 12, little); // align
    }
  });
  for (const [offset, content] of placed) bytes.set(content, offset);
  return bytes;
}

/** A recognisable stand-in for a thin Mach-O: its magic, then `tag` repeated. */
function thin(tag: number, length = 32): Uint8Array {
  const bytes = new Uint8Array(length).fill(tag);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  return bytes;
}

interface Run {
  readonly metadata: Metadata;
  readonly xml: string;
  readonly resources: EmbeddedDocumentBytesHandler["resources"];
}

async function runWith(
  bytes: Uint8Array | AsyncIterable<Uint8Array>,
  extractor: EmbeddedDocumentExtractor,
): Promise<{ metadata: Metadata; xml: string }> {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(bytes);
  const handler = createOutputHandler("xml");
  const metadata = new Metadata();
  try {
    await new UniversalExecutableParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

async function run(bytes: Uint8Array): Promise<Run> {
  const extractor = new EmbeddedDocumentBytesHandler();
  const { metadata, xml } = await runWith(bytes, extractor);
  return { metadata, xml, resources: extractor.resources };
}

// ---- what a fat file gives ----

test("each architecture is an embedded document of exactly its bytes, with its size as Content-Length, in all four layouts", async () => {
  for (const little of [false, true]) {
    for (const wide of [false, true]) {
      const first = thin(0x11, 40);
      const second = thin(0x22, 64);
      const bytes = fat({
        little,
        wide,
        entries: [
          { offset: 0x100, size: first.length },
          { offset: 0x200, size: second.length },
        ],
        place: [[0x100, first], [0x200, second]],
      });
      const { resources } = await run(bytes);
      const label = `little=${little} wide=${wide}`;
      assert.equal(resources.length, 2, label);
      assert.deepEqual([...resources[0]!.bytes], [...first], label);
      assert.deepEqual([...resources[1]!.bytes], [...second], label);
      assert.equal(resources[0]!.metadata.get("Content-Length"), "40", label);
      assert.equal(resources[1]!.metadata.get("Content-Length"), "64", label);
    }
  }
});

test("offsets are counted from where the stream was when the parse began", async () => {
  const arch = thin(0x5a, 32);
  const prefix = new Uint8Array(13).fill(0x77);
  const bytes = fat({ entries: [{ offset: 0x40, size: arch.length }], place: [[0x40, arch]] });
  const both = new Uint8Array(prefix.length + bytes.length);
  both.set(prefix, 0);
  both.set(bytes, prefix.length);
  const extractor = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, extractor);
  const stream = await RipstreamInputStream.from(both);
  try {
    await stream.seek(prefix.length);
    await new UniversalExecutableParser().parse(stream, createOutputHandler("xml"), new Metadata(), context);
  } finally {
    await stream.close();
  }
  assert.deepEqual([...extractor.resources[0]!.bytes], [...arch]);
});

test("the container itself gets no metadata and no text: only the embedded documents come out of it", async () => {
  const bytes = fat({ entries: [{ offset: 0x40, size: 32 }], place: [[0x40, thin(1)]] });
  const { metadata, xml } = await run(bytes);
  assert.equal(metadata.size(), 0);
  assert.match(xml, /<body ?\/>|<body><\/body>/);
});

test("an embedded document gets a fresh Metadata with nothing but its length, as TikaInputStream.get(bytes, metadata) leaves it", async () => {
  const { resources } = await run(fat({ entries: [{ offset: 0x40, size: 32 }], place: [[0x40, thin(1)]] }));
  const names = resources[0]!.metadata.names().filter((name) => !name.startsWith("tk:embedded-") && !name.startsWith("ripstream:"));
  assert.deepEqual(names, ["Content-Length"]);
});

test("the table is read in file order and the architectures are taken in offset order", async () => {
  const early = thin(0xaa);
  const late = thin(0xbb);
  const bytes = fat({
    entries: [
      { offset: 0x200, size: 32 },
      { offset: 0x100, size: 32 },
    ],
    place: [[0x200, late], [0x100, early]],
  });
  const { resources } = await run(bytes);
  assert.deepEqual(
    resources.map((resource) => resource.bytes[8]),
    [0xaa, 0xbb],
  );
});

test("an architecture of zero bytes is an empty embedded document, and two may share an offset", async () => {
  const bytes = fat({
    entries: [
      { offset: 0x80, size: 0 },
      { offset: 0x80, size: 0 },
      { offset: 0x80, size: 32 },
    ],
    place: [[0x80, thin(7)]],
  });
  const { resources } = await run(bytes);
  assert.deepEqual(
    resources.map((resource) => resource.bytes.length),
    [0, 0, 32],
  );
  assert.equal(resources[0]!.metadata.get("Content-Length"), "0");
});

test("padding between architectures is skipped, and bytes after the last are ignored", async () => {
  const bytes = fat({
    entries: [
      { offset: 0x1000, size: 32 },
      { offset: 0x4000, size: 32 },
    ],
    place: [[0x1000, thin(1)], [0x4000, thin(2)]],
    length: 0x6000,
  });
  const { resources } = await run(bytes);
  assert.deepEqual(
    resources.map((resource) => resource.bytes[8]),
    [1, 2],
  );
});

test("Tika's testMacOS-x86_64-arm64: the two architectures are the byte ranges its table gives, x86-64 then arm64", async () => {
  const file = fixture("testMacOS-x86_64-arm64");
  const { resources } = await run(file);
  assert.equal(resources.length, 2);
  // The table (read from the file's bytes): offset 0x1000 size 0x2100, offset 0x4000 size 0x82a0.
  assert.deepEqual([...resources[0]!.bytes], [...file.subarray(0x1000, 0x1000 + 0x2100)]);
  assert.deepEqual([...resources[1]!.bytes], [...file.subarray(0x4000, 0x4000 + 0x82a0)]);
  assert.equal(resources[0]!.metadata.get("Content-Length"), "8448");
  assert.equal(resources[1]!.metadata.get("Content-Length"), "33440");
  // Each is a thin 64-bit little-endian Mach-O: its magic, then the x86-64 and the arm64 CPU type.
  assert.deepEqual([...resources[0]!.bytes.subarray(0, 8)], [0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]);
  assert.deepEqual([...resources[1]!.bytes.subarray(0, 8)], [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
});

test("UniversalExecutableParserTest.testMachO: three records, the container and two Mach-O executables", async () => {
  const records = await createRipstream().parseRecursive(fixture("testMacOS-x86_64-arm64"));
  assert.equal(records.length, 3);
  assert.equal(records[0]!.metadata.get("Content-Type"), "application/x-mach-o-universal");
  for (const record of records.slice(1)) assert.equal(record.metadata.get("Content-Type"), "application/x-mach-o-executable");
  // What each embedded executable's header says (read from the files; Tika's test does not assert these).
  assert.deepEqual(
    records.slice(1).map((record) => record.metadata.get("machine:machineType")),
    ["x86-64", "ARM"],
  );
});

test("1000 architectures, Tika's MAX_ARCHS_COUNT, are read", async () => {
  const tableEnd = 8 + 1000 * 20;
  const entries = Array.from({ length: 1000 }, () => ({ offset: tableEnd, size: 0 }));
  const { resources } = await run(fat({ entries }));
  assert.equal(resources.length, 1000);
});

// ---- failures that are the file's ----

test("something that is not a fat file is an unsupported format", async () => {
  await assert.rejects(run(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 1])), UnsupportedFormatError);
  // The thin Mach-O magics are not the universal ones.
  await assert.rejects(run(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1])), UnsupportedFormatError);
});

test("fewer than four bytes, or a magic with no count, is refused as malformed", async () => {
  await assert.rejects(run(new Uint8Array([0xca, 0xfe, 0xba])), MalformedDocumentError);
  await assert.rejects(run(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0])), MalformedDocumentError);
});

test("an architecture count below 1 or above 1000 is refused, before any table is read", async () => {
  for (const count of [0, -1, -0x80000000, 1001, 0x7fffffff]) {
    await assert.rejects(run(fat({ count, entries: [{ offset: 0x40, size: 0 }] })), MalformedDocumentError, `count ${count}`);
  }
});

test("a table that the file ends in the middle of is refused, however many entries it declares", async () => {
  const header = fat({ count: 1000, entries: [] });
  await assert.rejects(run(header), MalformedDocumentError);
  await assert.rejects(run(fat({ count: 3, entries: [{ offset: 0x100, size: 0 }] })), MalformedDocumentError);
});

/** Rejects with a MalformedDocumentError whose message says which check refused the file, not just that one did. */
function malformed(pattern: RegExp): (error: unknown) => boolean {
  return (error) => error instanceof MalformedDocumentError && pattern.test(error.message);
}

test("an offset inside the table, or negative, is refused", async () => {
  const bad: ReadonlyArray<readonly [string, FatOptions, RegExp]> = [
    ["offset 8", { entries: [{ offset: 8, size: 0 }] }, /Invalid offset: 8$/],
    ["offset one short of the end of the table", { entries: [{ offset: 47, size: 0 }, { offset: 0x100, size: 0 }] }, /Invalid offset: 47$/],
    ["offset 0", { entries: [{ offset: 0, size: 0 }] }, /Invalid offset: 0$/],
    ["32-bit offset 0x80000000 (negative)", { entries: [{ offset: -0x80000000, size: 0 }] }, /Invalid offset: -2147483648$/],
    ["64-bit negative offset", { wide: true, entries: [{ offset: -1n, size: 0 }] }, /Invalid offset: -1$/],
    ["64-bit offset past any file", { wide: true, entries: [{ offset: 1n << 62n, size: 0 }] }, /past the end of any file/],
    ["64-bit offset at the top of a long", { wide: true, entries: [{ offset: (1n << 63n) - 1n, size: 0 }] }, /past the end of any file/],
  ];
  for (const [label, options, pattern] of bad) {
    await assert.rejects(run(fat({ ...options, length: 0x200 })), malformed(pattern), label);
  }
});

test("an offset right at the end of the table is accepted", async () => {
  const { resources } = await run(fat({ entries: [{ offset: 28, size: 4 }], place: [[28, new Uint8Array([1, 2, 3, 4])]] }));
  assert.deepEqual([...resources[0]!.bytes], [1, 2, 3, 4]);
});

test("a size that is negative, over 500,000,000, or past the end of the file is refused", async () => {
  const bad: ReadonlyArray<readonly [string, FatOptions, RegExp]> = [
    ["32-bit size 0x80000000 (negative)", { entries: [{ offset: 0x40, size: -0x80000000 }] }, /Arch size=-2147483648 /],
    ["32-bit size -1", { entries: [{ offset: 0x40, size: -1 }] }, /Arch size=-1 /],
    ["64-bit negative size", { wide: true, entries: [{ offset: 0x80, size: -1n }] }, /Arch size=-1 /],
    ["over Tika's cap by one", { entries: [{ offset: 0x40, size: 500_000_001 }] }, /Arch size=500000001 /],
    ["64-bit 2^40", { wide: true, entries: [{ offset: 0x80, size: 1n << 40n }] }, /Arch size=1099511627776 /],
    ["64-bit top of a long", { wide: true, entries: [{ offset: 0x80, size: (1n << 63n) - 1n }] }, /Arch size=9223372036854775807 /],
    ["within the cap, past the end of the file", { entries: [{ offset: 0x40, size: 499_999_999 }] }, /extends past the end of the file/],
    ["500,000,000 itself is within the cap, so it is the file's end that refuses it", { entries: [{ offset: 0x40, size: 500_000_000 }] }, /extends past the end of the file/],
    ["one byte past the end of the file", { entries: [{ offset: 0x40, size: 0x100 - 0x40 + 1 }] }, /extends past the end of the file/],
  ];
  for (const [label, options, pattern] of bad) {
    await assert.rejects(run(fat({ ...options, length: 0x100 })), malformed(pattern), label);
  }
});

test("a size past the end of the file does not allocate that size", async () => {
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(run(fat({ entries: [{ offset: 0x40, size: 499_999_999 }], length: 0x100 })), MalformedDocumentError);
  const grown = process.memoryUsage().arrayBuffers - before;
  assert.ok(grown < 64 * 1024 * 1024, `array buffers grew by ${grown} bytes`);
});

test("architectures that overlap are refused, after the ones before them were taken, as in Tika", async () => {
  const extractor = new EmbeddedDocumentBytesHandler();
  const bytes = fat({
    entries: [
      { offset: 0x80, size: 0x40 },
      { offset: 0x90, size: 0x10 },
    ],
    length: 0x200,
  });
  await assert.rejects(runWith(bytes, extractor), MalformedDocumentError);
  assert.equal(extractor.resources.length, 1);
});

test("an architecture the file ends in the middle of is refused, after the ones before it were taken", async () => {
  const extractor = new EmbeddedDocumentBytesHandler();
  const bytes = fat({
    entries: [
      { offset: 0x40, size: 32 },
      { offset: 0x100, size: 0x1000 },
    ],
    place: [[0x40, thin(1)]],
    length: 0x180,
  });
  await assert.rejects(runWith(bytes, extractor), MalformedDocumentError);
  assert.equal(extractor.resources.length, 1);
});

test("every prefix of a fat file is refused as malformed until it holds the last architecture", async () => {
  for (const [little, wide] of [[false, false], [true, true]] as const) {
    const first = thin(1);
    const second = thin(2);
    const full = fat({
      little,
      wide,
      entries: [
        { offset: 0x60, size: first.length },
        { offset: 0x90, size: second.length },
      ],
      place: [[0x60, first], [0x90, second]],
    });
    const needed = 0x90 + second.length;
    for (let length = 0; length <= full.length; length++) {
      const label = `little=${little} wide=${wide}, prefix of ${length} bytes`;
      if (length === 0) continue; // an empty input never reaches a parser: AutoDetectParser refuses it first
      if (length >= needed) {
        assert.equal((await run(full.slice(0, length))).resources.length, 2, label);
      } else {
        await assert.rejects(run(full.slice(0, length)), MalformedDocumentError, label);
      }
    }
  }
});

// ---- the embedded documents are the extractor's ----

/** Records what it was given, and fails the documents the test names. */
class Recording implements EmbeddedDocumentExtractor {
  readonly seen: Metadata[] = [];
  readonly #fails: (index: number) => Error | null;
  readonly #parses: boolean;

  constructor(fails: (index: number) => Error | null, parses = true) {
    this.#fails = fails;
    this.#parses = parses;
  }

  shouldParseEmbedded(): boolean {
    return this.#parses;
  }

  async parseEmbedded(stream: RipstreamInputStream, _handler: ContentHandler, metadata: Metadata): Promise<void> {
    const index = this.seen.length;
    this.seen.push(metadata);
    for await (const chunk of stream) void chunk; // reads the document, so the arch stream is exercised
    const failure = this.#fails(index);
    if (failure !== null) throw failure;
  }
}

test("a document that fails to parse is recorded on its own metadata and the next architecture is still taken", async () => {
  const recording = new Recording((index) => (index === 0 ? new MalformedDocumentError("cannot read arch 0") : null));
  const bytes = fat({
    entries: [{ offset: 0x40, size: 32 }, { offset: 0x80, size: 32 }],
    place: [[0x40, thin(1)], [0x80, thin(2)]],
  });
  await runWith(bytes, recording);
  assert.equal(recording.seen.length, 2);
  assert.match(recording.seen[0]!.get(TIKA_KEYS.EMBEDDED_EXCEPTION) ?? "", /MalformedDocumentError: cannot read arch 0/);
  assert.equal(recording.seen[1]!.get(TIKA_KEYS.EMBEDDED_EXCEPTION), null);
});

test("a limit reached inside an embedded document ends the parse", async () => {
  const recording = new Recording((index) => (index === 0 ? new LimitExceededError("too many") : null));
  const bytes = fat({
    entries: [{ offset: 0x40, size: 32 }, { offset: 0x80, size: 32 }],
    place: [[0x40, thin(1)], [0x80, thin(2)]],
  });
  await assert.rejects(runWith(bytes, recording), LimitExceededError);
  assert.equal(recording.seen.length, 1);
});

test("an extractor that declines the documents gets none of them, and the parse still succeeds", async () => {
  const recording = new Recording(() => null, false);
  const bytes = fat({ entries: [{ offset: 0x40, size: 32 }], place: [[0x40, thin(1)]] });
  await runWith(bytes, recording);
  assert.equal(recording.seen.length, 0);
});

test("only as much of a stream is read as the architectures need, however long it goes on", async () => {
  const cap = 40;
  let pulled = 0;
  const bytes = fat({
    entries: [{ offset: 0x100, size: 32 }, { offset: 0x200, size: 32 }],
    place: [[0x100, thin(1)], [0x200, thin(2)]],
    length: 0x1000,
  });
  async function* endless(): AsyncGenerator<Uint8Array> {
    yield bytes;
    for (;;) {
      if (++pulled > cap) throw new Error(`the parser pulled more than ${cap} chunks of an endless stream`);
      yield new Uint8Array(1024);
    }
  }
  const extractor = new EmbeddedDocumentBytesHandler();
  await runWith(endless(), extractor);
  assert.equal(extractor.resources.length, 2);
  assert.ok(pulled <= 2, `pulled ${pulled} chunks`);
});

// ---- registration (tikajs-68os.17) ----

test("UniversalExecutableParser claims application/x-mach-o-universal, as Tika's does, and the composite selects it exactly", async () => {
  const claimed = [...new UniversalExecutableParser().getSupportedTypes()].map((type) => type.toString());
  assert.deepEqual(claimed, [...(TIKA_PARSER_TYPES["universal-executable-parser"] ?? [])]);
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow("application/x-mach-o-universal"), new ParseContext());
  assert.deepEqual(
    matches.map((match) => ({ name: match.parser.name, kind: match.kind })),
    [{ name: "UniversalExecutableParser", kind: "exact" }],
  );
});
