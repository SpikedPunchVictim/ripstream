import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParseContext,
  RipstreamInputStream,
  createOutputHandler,
} from "@spikedpunch/ripstream-core";
import { TIKA_PARSER_TYPES } from "../src/generated/tika-parser-types.ts";
import { ExecutableParser, createDefaultParser } from "../src/index.ts";

/*
 * ExecutableParser is ported from Tika 4.2.0's ExecutableParser.java. The expectations below are what that source does
 * when read, and what ExecutableParserTest asserts (the fixtures under fixtures/executable/ carry its files); none of
 * this was run against a Tika, which is not available here.
 */

const KEY = {
  bits: "machine:architectureBits",
  platform: "machine:platform",
  machine: "machine:machineType",
  endian: "machine:endian",
  type: "Content-Type",
  created: "dcterms:created",
} as const;

interface Parsed {
  readonly metadata: Metadata;
  readonly xml: string;
}

async function parseExecutable(bytes: Uint8Array): Promise<Parsed> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = createOutputHandler("xml");
  const metadata = new Metadata();
  try {
    await new ExecutableParser().parse(stream, handler, metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return { metadata, xml: handler.toString() };
}

/** What the parser set, by key, for the keys this test file looks at; an unset key is null. */
function seen(metadata: Metadata): Record<string, string | null> {
  return Object.fromEntries(Object.values(KEY).map((key) => [key, metadata.get(key)]));
}

// ---- header builders: a header and nothing else, so each byte a test sets is the byte the parser reads ----

function pe(options: { machine?: number; peOffset?: number; created?: number; signature?: readonly number[] } = {}): Uint8Array {
  const peOffset = options.peOffset ?? 0x80;
  const bytes = new Uint8Array(Math.max(0x100, peOffset + 24 + 16));
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a], 0);
  view.setInt32(0x3c, peOffset, true);
  if (peOffset >= 0x40) {
    bytes.set(options.signature ?? [0x50, 0x45, 0, 0], peOffset);
    view.setUint16(peOffset + 4, options.machine ?? 0x14c, true);
    view.setInt32(peOffset + 8, options.created ?? 0, true);
  }
  return bytes;
}

function elf(
  options: { bits?: number; data?: number; osAbi?: number; abiVersion?: number; type?: number; machine?: number } = {},
): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  const data = options.data ?? 1;
  bytes.set([0x7f, 0x45, 0x4c, 0x46, options.bits ?? 2, data, 1, options.osAbi ?? 0, options.abiVersion ?? 0], 0);
  const little = data === 1;
  view.setUint16(16, options.type ?? 2, little);
  view.setUint16(18, options.machine ?? 62, little);
  return bytes;
}

function macho(options: { little?: boolean; wide?: boolean; cpu?: number; fileType?: number } = {}): Uint8Array {
  const little = options.little ?? true;
  const wide = options.wide ?? true;
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  // 0xFEEDFACE / 0xFEEDFACF written in the file's own byte order, as dyld reads them.
  view.setUint32(0, wide ? 0xfeedfacf : 0xfeedface, little);
  view.setInt32(4, options.cpu ?? (wide ? 0x01000007 : 7), little);
  view.setInt32(12, options.fileType ?? 2, little);
  return bytes;
}

// ---- the header description ----

test("a PE file has no text and its header becomes metadata (ExecutableParserTest.testWin32Parser, built from bytes)", async () => {
  const { metadata, xml } = await parseExecutable(pe({ machine: 0x14c, created: 1_336_916_411 }));
  assert.deepEqual(seen(metadata), {
    [KEY.bits]: "32",
    [KEY.platform]: "Windows",
    [KEY.machine]: "x86-32",
    [KEY.endian]: "Little",
    [KEY.type]: "application/x-msdownload",
    [KEY.created]: "2012-05-13T13:40:11Z",
  });
  assert.match(xml, /<body ?\/>|<body><\/body>/, "Tika's test asserts <body /> (no text yet)");
});

test("a PE offset inside the DOS header is an MS-DOS file, not a failure (ExecutableParserTest.testPeOffsetInsideDosHeader)", async () => {
  const mz = new Uint8Array(0x100);
  mz[0] = 0x4d;
  mz[1] = 0x5a;
  mz[0x3c] = 0x3f;
  const { metadata } = await parseExecutable(mz);
  assert.equal(metadata.get(KEY.platform), "Windows");
  assert.equal(metadata.get(KEY.machine), null);
  assert.equal(metadata.get(KEY.type), "application/x-msdownload");
});

test("the PE header is looked for up to offset 4096 and not beyond", async () => {
  assert.equal((await parseExecutable(pe({ peOffset: 4096 }))).metadata.get(KEY.machine), "x86-32");
  assert.equal((await parseExecutable(pe({ peOffset: 4097 }))).metadata.get(KEY.machine), null);
  assert.equal((await parseExecutable(pe({ peOffset: 0x40 }))).metadata.get(KEY.machine), "x86-32");
  assert.equal((await parseExecutable(pe({ peOffset: -1 }))).metadata.get(KEY.machine), null, "a negative offset");
});

test("an MZ file whose PE signature is wrong is left at Windows with no machine", async () => {
  const { metadata } = await parseExecutable(pe({ signature: [0x50, 0x45, 0, 1] }));
  assert.deepEqual(seen(metadata), {
    [KEY.bits]: null,
    [KEY.platform]: "Windows",
    [KEY.machine]: null,
    [KEY.endian]: null,
    [KEY.type]: "application/x-msdownload",
    [KEY.created]: null,
  });
});

test("every machine value the Java switch names, with its endianness and bit width", async () => {
  // [IMAGE_FILE_MACHINE, machine type, endian, bits]; null where the Java sets nothing.
  const table: ReadonlyArray<readonly [number, string, string | null, string | null]> = [
    [0x14c, "x86-32", "Little", "32"],
    [0x8664, "x86-64", "Little", "64"],
    [0x200, "IA-64", "Little", "64"],
    [0x184, "Alpha", "Little", "32"],
    [0x284, "Alpha", "Little", "64"],
    [0x1c0, "ARM", "Little", "32"],
    [0x1c4, "ARM", "Little", "32"],
    [0x268, "Motorola-68000", "Big", "32"],
    [0x266, "MIPS", "Big", "16"],
    [0x366, "MIPS", "Big", "16"],
    [0x466, "MIPS", "Big", "16"],
    [0x162, "MIPS", "Little", "16"],
    [0x166, "MIPS", "Little", "16"],
    [0x168, "MIPS", "Little", "16"],
    [0x169, "MIPS", "Little", "16"],
    [0x1f0, "PPC", "Little", "32"],
    [0x1f1, "PPC", "Little", "32"],
    [0x1a2, "SH3", "Big", "32"],
    [0x1a3, "SH3", "Big", "32"],
    [0x1a6, "SH4", "Big", "32"],
    [0x1a8, "SH3", "Big", "32"],
    [0x9041, "M32R", "Big", "32"],
    [0xebc, "EFI", null, null],
    // Not in the switch, so Unknown: the PE machine of an ARM64 Windows file is one of them.
    [0xaa64, "Unknown", null, null],
    [0x0, "Unknown", null, null],
  ];
  for (const [machine, type, endian, bits] of table) {
    const { metadata } = await parseExecutable(pe({ machine }));
    assert.deepEqual(
      [metadata.get(KEY.machine), metadata.get(KEY.endian), metadata.get(KEY.bits)],
      [type, endian, bits],
      `machine 0x${machine.toString(16)}`,
    );
  }
});

test("the PE creation time is a signed 32-bit count of seconds, written to the second in UTC", async () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [0, "1970-01-01T00:00:00Z"],
    [-1, "1969-12-31T23:59:59Z"],
    [0x7fffffff, "2038-01-19T03:14:07Z"],
    [-0x80000000, "1901-12-13T20:45:52Z"],
  ];
  for (const [seconds, expected] of cases) {
    assert.equal((await parseExecutable(pe({ created: seconds }))).metadata.get(KEY.created), expected, String(seconds));
  }
});

test("an ELF file: bits, endianness, type and machine, and a platform only when an OS byte is set", async () => {
  const x64 = (await parseExecutable(elf())).metadata;
  assert.deepEqual(seen(x64), {
    [KEY.bits]: "64",
    [KEY.platform]: null,
    [KEY.machine]: "x86-64",
    [KEY.endian]: "Little",
    [KEY.type]: "application/x-executable",
    [KEY.created]: null,
  });
  const arm = (await parseExecutable(elf({ bits: 1, machine: 40 }))).metadata;
  assert.equal(arm.get(KEY.bits), "32");
  assert.equal(arm.get(KEY.machine), "ARM");
});

test("an ELF byte order of 2 reads the type and machine big-endian; any other value reads them big-endian too, with no endian key", async () => {
  const big = (await parseExecutable(elf({ data: 2, type: 3, machine: 8 }))).metadata;
  assert.equal(big.get(KEY.endian), "Big");
  assert.equal(big.get(KEY.type), "application/x-sharedlib");
  assert.equal(big.get(KEY.machine), "MIPS");
  // The Java tests `endian == 1` for little and takes everything else as big.
  const odd = (await parseExecutable(elf({ data: 0, type: 1, machine: 3 }))).metadata;
  assert.equal(odd.get(KEY.endian), null);
  assert.equal(odd.get(KEY.type), "application/x-object");
  assert.equal(odd.get(KEY.machine), "x86-32");
  const noBits = (await parseExecutable(elf({ bits: 3 }))).metadata;
  assert.equal(noBits.get(KEY.bits), null);
});

test("an ELF object type picks the media type", async () => {
  const types: ReadonlyArray<readonly [number, string]> = [
    [1, "application/x-object"],
    [2, "application/x-executable"],
    [3, "application/x-sharedlib"],
    [4, "application/x-coredump"],
    [0, "application/x-elf"],
    [5, "application/x-elf"],
    [0xfe00, "application/x-elf"],
  ];
  for (const [type, expected] of types) {
    assert.equal((await parseExecutable(elf({ type }))).metadata.get(KEY.type), expected, `e_type ${type}`);
  }
});

test("an ELF OS ABI maps to a platform; the pair (0, 0) and an unnamed value set none", async () => {
  const platforms: ReadonlyArray<readonly [number, number, string | null]> = [
    [0, 0, null],
    [0, 1, "System V"],
    [1, 0, "HP-UX"],
    [2, 0, "NetBSD"],
    [3, 0, "Linux"],
    [4, 0, null],
    [6, 0, "Solaris"],
    [7, 0, "AIX"],
    [8, 0, "IRIX"],
    [9, 0, "FreeBSD"],
    [10, 0, "Tru64"],
    [12, 0, "FreeBSD"],
    [64, 0, "ARM"],
    [97, 0, "ARM"],
    [255, 0, "Embedded"],
    [5, 7, null],
  ];
  for (const [osAbi, abiVersion, expected] of platforms) {
    const { metadata } = await parseExecutable(elf({ osAbi, abiVersion }));
    assert.equal(metadata.get(KEY.platform), expected, `OS ABI ${osAbi}, version ${abiVersion}`);
  }
});

test("every ELF machine value the Java switch names", async () => {
  const machines: ReadonlyArray<readonly [number, string | null]> = [
    [2, "SPARC"],
    [18, "SPARC"],
    [43, "SPARC"],
    [3, "x86-32"],
    [4, "Motorola-68000"],
    [5, "Motorola-88000"],
    [8, "MIPS"],
    [10, "MIPS"],
    [7, "S370"],
    [20, "PPC"],
    [21, "PPC"],
    [22, "S390"],
    [40, "ARM"],
    [41, "Alpha"],
    [0x9026, "Alpha"],
    [50, "IA-64"],
    [62, "x86-64"],
    [75, "Vax"],
    [88, "M32R"],
    // AArch64 is not in the switch: no machine type.
    [183, null],
    [0, null],
  ];
  for (const [machine, expected] of machines) {
    assert.equal((await parseExecutable(elf({ machine }))).metadata.get(KEY.machine), expected, `e_machine ${machine}`);
  }
});

test("a Mach-O file: byte order from the magic, 64 bits only when the CPU type says so, type from the file type", async () => {
  const x64 = (await parseExecutable(macho())).metadata;
  assert.deepEqual(seen(x64), {
    [KEY.bits]: "64",
    [KEY.platform]: null,
    [KEY.machine]: "x86-64",
    [KEY.endian]: "Little",
    [KEY.type]: "application/x-mach-o-executable",
    [KEY.created]: null,
  });
  // The Java never sets "32": a 32-bit CPU type leaves the bit width out.
  const i386 = (await parseExecutable(macho({ wide: false }))).metadata;
  assert.equal(i386.get(KEY.machine), "x86-32");
  assert.equal(i386.get(KEY.bits), null);
  const bigEndianArm = (await parseExecutable(macho({ little: false, cpu: 0x0100000c }))).metadata;
  assert.equal(bigEndianArm.get(KEY.endian), "Big");
  assert.equal(bigEndianArm.get(KEY.machine), "ARM");
  assert.equal(bigEndianArm.get(KEY.bits), "64");
});

test("all four Mach-O magics are read, in the byte order the magic gives", async () => {
  for (const [little, wide] of [[true, true], [true, false], [false, true], [false, false]] as const) {
    const { metadata } = await parseExecutable(macho({ little, wide, fileType: 6 }));
    assert.equal(metadata.get(KEY.endian), little ? "Little" : "Big");
    assert.equal(metadata.get(KEY.type), "application/x-mach-o-dylib", `little=${little} wide=${wide}`);
  }
});

test("every Mach-O CPU type the Java switch names", async () => {
  const cpus: ReadonlyArray<readonly [number, string | null, string | null]> = [
    [1, "Vax", null],
    [6, "Motorola-68000", null],
    [7, "x86-32", null],
    [0x01000007, "x86-64", "64"],
    [8, "MIPS", null],
    [12, "ARM", null],
    [0x0100000c, "ARM", "64"],
    [13, "Motorola-88000", null],
    [14, "SPARC", null],
    [18, "PPC", null],
    // PowerPC 64 has the 64-bit flag but no case of its own: bits, no machine type.
    [0x01000012, null, "64"],
    // Only a flag of exactly 1 in the top byte is 64 bits: the ABI flag of arm64_32 (2) is another one.
    [0x0200000c, null, null],
    [99, null, null],
  ];
  for (const [cpu, machine, bits] of cpus) {
    const { metadata } = await parseExecutable(macho({ cpu }));
    assert.deepEqual([metadata.get(KEY.machine), metadata.get(KEY.bits)], [machine, bits], `cputype 0x${cpu.toString(16)}`);
  }
});

test("every Mach-O file type the Java switch names, and the generic type for the rest", async () => {
  const fileTypes: ReadonlyArray<readonly [number, string]> = [
    [1, "application/x-mach-o-object"],
    [2, "application/x-mach-o-executable"],
    [3, "application/x-mach-o-fvmlib"],
    [4, "application/x-mach-o-core"],
    [5, "application/x-mach-o-preload"],
    [6, "application/x-mach-o-dylib"],
    [7, "application/x-mach-o-dylinker"],
    [8, "application/x-mach-o-bundle"],
    [9, "application/x-mach-o-dylib-stub"],
    [10, "application/x-mach-o-dsym"],
    [11, "application/x-mach-o-kext-bundle"],
    [0, "application/x-mach-o"],
    [12, "application/x-mach-o"],
    [-1, "application/x-mach-o"],
  ];
  for (const [fileType, expected] of fileTypes) {
    assert.equal((await parseExecutable(macho({ fileType }))).metadata.get(KEY.type), expected, `filetype ${fileType}`);
  }
});

test("a file with none of the four magics is an empty document, as in Tika, not a failure", async () => {
  const { metadata, xml } = await parseExecutable(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(metadata.size(), 0);
  assert.match(xml, /<body ?\/>|<body><\/body>/);
});

test("fewer than four bytes is refused as malformed", async () => {
  await assert.rejects(parseExecutable(new Uint8Array([0x7f, 0x45, 0x4c])), MalformedDocumentError);
});

// ---- hostile input ----

async function assertPrefixesParseOrAreMalformed(full: Uint8Array, label: string): Promise<void> {
  for (let length = 0; length <= full.length; length++) {
    try {
      await parseExecutable(full.slice(0, length));
    } catch (error) {
      assert.ok(
        error instanceof MalformedDocumentError,
        `${label}, prefix of ${length} bytes: ${error instanceof Error ? error.constructor.name : String(error)}`,
      );
    }
  }
}

test("every prefix of a PE, ELF or Mach-O file parses or is refused as malformed", async () => {
  await assertPrefixesParseOrAreMalformed(pe({ peOffset: 0x80 }).subarray(0, 0x80 + 24 + 4), "pe");
  await assertPrefixesParseOrAreMalformed(elf(), "elf");
  await assertPrefixesParseOrAreMalformed(elf({ data: 2 }), "elf big-endian");
  await assertPrefixesParseOrAreMalformed(macho(), "mach-o");
  await assertPrefixesParseOrAreMalformed(macho({ little: false, wide: false }), "mach-o big-endian");
});

test("a header cut short leaves the metadata that was set before the cut, as Tika's does", async () => {
  const metadata = new Metadata();
  const stream = await RipstreamInputStream.from(pe().subarray(0, 0x50));
  await assert.rejects(
    new ExecutableParser().parse(stream, createOutputHandler("xml"), metadata, new ParseContext()),
    MalformedDocumentError,
  );
  await stream.close();
  assert.equal(metadata.get(KEY.platform), "Windows");
});

test("only the start of a stream is read, however long the stream is", async () => {
  // Tika reads at most a few kilobytes. A parser that reads to the end of this stream trips the cap and the test fails.
  const header = elf();
  const cap = 40;
  let pulled = 0;
  async function* endless(): AsyncGenerator<Uint8Array> {
    yield header;
    for (;;) {
      if (++pulled > cap) throw new Error(`the parser pulled more than ${cap} chunks of an endless stream`);
      yield new Uint8Array(1024);
    }
  }
  const stream = await RipstreamInputStream.from(endless());
  const metadata = new Metadata();
  try {
    await new ExecutableParser().parse(stream, createOutputHandler("xml"), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  assert.equal(metadata.get(KEY.machine), "x86-64");
  assert.ok(pulled <= 8, `pulled ${pulled} chunks`);
});

// ---- registration (tikajs-68os.17) ----

/** The parsers selectParsers picks for a type through the registry (aliases and supertypes), best match first. */
async function selected(type: string): Promise<{ name: string; kind: string }[]> {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow(type), new ParseContext());
  return matches.map((match) => ({ name: match.parser.name, kind: match.kind }));
}

test("ExecutableParser claims the 18 types Tika's does, and no others", async () => {
  const tika = [...(TIKA_PARSER_TYPES["executable-parser"] ?? [])].sort();
  assert.equal(tika.length, 18);
  const claimed = [...new ExecutableParser().getSupportedTypes()].map((type) => type.toString()).sort();
  assert.deepEqual(claimed, tika);
});

test("each of the 18 types selects ExecutableParser exactly, none through a supertype or alias", async () => {
  for (const type of TIKA_PARSER_TYPES["executable-parser"] ?? []) {
    const [first] = await selected(type);
    assert.deepEqual(first, { name: "ExecutableParser", kind: "exact" }, type);
  }
});

test("a forced-type parse of each ELF variant reaches ExecutableParser exactly and reads the header", async () => {
  // Detection is bypassed: the type is put in the context as a caller that already knows it would. The header's e_type
  // wins over the forced type, as in Tika, where parseELF sets Content-Type from the file.
  for (const forced of ["application/x-object", "application/x-sharedlib", "application/x-coredump"]) {
    const context = new ParseContext();
    context.set(CONTEXT_KEYS.CONTENT_TYPE, MediaType.parseOrThrow(forced));
    const metadata = new Metadata();
    const stream = await RipstreamInputStream.from(elf({ type: 1, machine: 40, bits: 1 }));
    try {
      await createDefaultParser().parse(stream, createOutputHandler("xml"), metadata, context);
    } finally {
      await stream.close();
    }
    assert.deepEqual(metadata.getAll("tk:parsed-by"), ["ExecutableParser"], forced);
    assert.equal(metadata.get(KEY.type), "application/x-object", forced);
    assert.equal(metadata.get(KEY.machine), "ARM", forced);
    assert.equal(metadata.get(KEY.bits), "32", forced);
  }
});
