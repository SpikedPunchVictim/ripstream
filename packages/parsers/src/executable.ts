import {
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/*
 * Port of Tika 4.2.0's ExecutableParser (tika-parser-code-module), read from that source and not run against a Tika:
 * PE, ELF and Mach-O headers become the `machine:*` metadata and, for ELF and Mach-O, the media type; there is no text.
 * Not ported: PEIconExtractor (the icons of a PE file as embedded documents) and ExecutableParserConfig, which only
 * switches it. The 32-bit Mach-O width, the PE machine 0xaa64 (ARM64) and the ELF machine 183 (AArch64) are not set,
 * because the Java's switches do not name them.
 */

const MEDIA_TYPES = [
  "application/x-msdownload",
  "application/x-elf",
  "application/x-object",
  "application/x-executable",
  "application/x-sharedlib",
  "application/x-coredump",
  "application/x-mach-o",
  "application/x-mach-o-object",
  "application/x-mach-o-executable",
  "application/x-mach-o-fvmlib",
  "application/x-mach-o-core",
  "application/x-mach-o-preload",
  "application/x-mach-o-dylib",
  "application/x-mach-o-dylinker",
  "application/x-mach-o-bundle",
  "application/x-mach-o-dylib-stub",
  "application/x-mach-o-dsym",
  "application/x-mach-o-kext-bundle",
];

// MachineMetadata's keys and values.
const ARCHITECTURE_BITS = "machine:architectureBits";
const PLATFORM = "machine:platform";
const MACHINE_TYPE = "machine:machineType";
const ENDIAN = "machine:endian";
const CONTENT_TYPE = "Content-Type";
const CREATED = "dcterms:created";

const LITTLE = "Little";
const BIG = "Big";

const MACHINE = {
  x86_32: "x86-32",
  x86_64: "x86-64",
  ia64: "IA-64",
  sparc: "SPARC",
  m68k: "Motorola-68000",
  m88k: "Motorola-88000",
  mips: "MIPS",
  ppc: "PPC",
  s370: "S370",
  s390: "S390",
  arm: "ARM",
  vax: "Vax",
  alpha: "Alpha",
  efi: "EFI",
  m32r: "M32R",
  sh3: "SH3",
  sh4: "SH4",
  unknown: "Unknown",
} as const;

const PE_MEDIA_TYPE = "application/x-msdownload";
const ELF_GENERAL = "application/x-elf";
const MACHO_GENERAL = "application/x-mach-o";

/**
 * The most of a file the parser looks at. Tika treats a PE header offset above 4096 as no PE header, and the COFF
 * header it reads there is 24 bytes, so nothing is read past this and a long file costs no more than a short one.
 */
const MAX_PE_OFFSET = 4096;
const COFF_HEADER_BYTES = 24;
const HEADER_BYTES = MAX_PE_OFFSET + COFF_HEADER_BYTES;

/** PE/COFF, ELF and Mach-O header description (no disassembly). */
export class ExecutableParser implements Parser {
  readonly name = "ExecutableParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(MEDIA_TYPES.map((type) => MediaType.parseOrThrow(type)));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    // The document is started before the header is read, as in Tika, so what is read is written to the head at the end.
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    readHeader(new HeaderReader(await stream.peek(HEADER_BYTES)), metadata);
    await xhtml.endDocument();
  }
}

/**
 * The start of the file, read as Tika reads the start of its InputStream: a header cut short is an error (an
 * EOFException there), except for `read()`, which answers -1 at the end.
 */
class HeaderReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #position = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  read(): number {
    return this.#position < this.#bytes.length ? this.#bytes[this.#position++]! : -1;
  }

  readFully(count: number): Uint8Array {
    this.#require(count);
    const bytes = this.#bytes.subarray(this.#position, this.#position + count);
    this.#position += count;
    return bytes;
  }

  skipFully(count: number): void {
    this.#require(count);
    this.#position += count;
  }

  readUShort(little: boolean): number {
    this.#require(2);
    const value = this.#view.getUint16(this.#position, little);
    this.#position += 2;
    return value;
  }

  readInt(little: boolean): number {
    this.#require(4);
    const value = this.#view.getInt32(this.#position, little);
    this.#position += 4;
    return value;
  }

  #require(count: number): void {
    if (count > this.#bytes.length - this.#position) throw new MalformedDocumentError("Truncated executable header");
  }
}

function readHeader(reader: HeaderReader, metadata: Metadata): void {
  const first4 = reader.readFully(4);
  const b0 = first4[0];
  const b1 = first4[1];
  const b2 = first4[2];
  const b3 = first4[3];
  if (b0 === 0x4d && b1 === 0x5a) {
    readPe(reader, metadata);
  } else if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) {
    readElf(reader, metadata);
  } else if ((b0 === 0xcf || b0 === 0xce) && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) {
    readMachO(reader, metadata, true);
  } else if (b0 === 0xfe && b1 === 0xed && b2 === 0xfa && (b3 === 0xcf || b3 === 0xce)) {
    readMachO(reader, metadata, false);
  }
  // Anything else is not an error in Tika either: the document is empty and nothing is set.
}

// ---- PE ----

interface PeMachine {
  readonly machine: string;
  readonly endian?: string;
  readonly bits?: string;
}

function peMachines(codes: readonly number[], value: PeMachine): Array<[number, PeMachine]> {
  return codes.map((code) => [code, value]);
}

/** The cases of parsePEHeader's switch on the COFF machine; "16" for MIPS is what the Java sets. */
const PE_MACHINES: ReadonlyMap<number, PeMachine> = new Map([
  ...peMachines([0x14c], { machine: MACHINE.x86_32, endian: LITTLE, bits: "32" }),
  ...peMachines([0x8664], { machine: MACHINE.x86_64, endian: LITTLE, bits: "64" }),
  ...peMachines([0x200], { machine: MACHINE.ia64, endian: LITTLE, bits: "64" }),
  ...peMachines([0x184], { machine: MACHINE.alpha, endian: LITTLE, bits: "32" }),
  ...peMachines([0x284], { machine: MACHINE.alpha, endian: LITTLE, bits: "64" }),
  ...peMachines([0x1c0, 0x1c4], { machine: MACHINE.arm, endian: LITTLE, bits: "32" }),
  ...peMachines([0x268], { machine: MACHINE.m68k, endian: BIG, bits: "32" }),
  ...peMachines([0x266, 0x366, 0x466], { machine: MACHINE.mips, endian: BIG, bits: "16" }),
  ...peMachines([0x162, 0x166, 0x168, 0x169], { machine: MACHINE.mips, endian: LITTLE, bits: "16" }),
  ...peMachines([0x1f0, 0x1f1], { machine: MACHINE.ppc, endian: LITTLE, bits: "32" }),
  ...peMachines([0x1a2, 0x1a3], { machine: MACHINE.sh3, endian: BIG, bits: "32" }),
  ...peMachines([0x1a6], { machine: MACHINE.sh4, endian: BIG, bits: "32" }),
  ...peMachines([0x1a8], { machine: MACHINE.sh3, endian: BIG, bits: "32" }),
  ...peMachines([0x9041], { machine: MACHINE.m32r, endian: BIG, bits: "32" }),
  ...peMachines([0xebc], { machine: MACHINE.efi }),
]);

/** ExecutableParser.parsePEHeader. The media type and platform are set before the header is known to be a PE one. */
function readPe(reader: HeaderReader, metadata: Metadata): void {
  metadata.set(CONTENT_TYPE, PE_MEDIA_TYPE);
  metadata.set(PLATFORM, "Windows");

  // The rest of the MS-DOS header, up to e_lfanew, the offset of the PE header.
  reader.skipFully(0x3c - 4);
  const peOffset = reader.readInt(true);

  // While a PE header may be anywhere, it is normally in the first few kilobytes; one inside the DOS header is none.
  if (peOffset > MAX_PE_OFFSET || peOffset < 0x40) return;
  reader.skipFully(peOffset - 0x40);

  const pe = reader.readFully(COFF_HEADER_BYTES);
  const view = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
  const isPeSignature = pe[0] === 0x50 && pe[1] === 0x45 && pe[2] === 0 && pe[3] === 0;
  if (!isPeSignature) return; // old-style MS-DOS

  const machine = view.getUint16(4, true);
  const createdAt = view.getInt32(8, true);

  // A signed count of seconds: 1901 to 2038, which the ISO form of a Date holds. Tika writes it to the second.
  metadata.set(CREATED, `${new Date(createdAt * 1000).toISOString().slice(0, 19)}Z`);

  const known = PE_MACHINES.get(machine);
  if (known === undefined) {
    metadata.set(MACHINE_TYPE, MACHINE.unknown);
    return;
  }
  metadata.set(MACHINE_TYPE, known.machine);
  if (known.endian !== undefined) metadata.set(ENDIAN, known.endian);
  if (known.bits !== undefined) metadata.set(ARCHITECTURE_BITS, known.bits);
}

// ---- ELF ----

/** e_ident[EI_OSABI] to the platform; 12 is FreeBSD here, as in the Java. */
const ELF_PLATFORMS: ReadonlyMap<number, string> = new Map([
  [0, "System V"],
  [1, "HP-UX"],
  [2, "NetBSD"],
  [3, "Linux"],
  [6, "Solaris"],
  [7, "AIX"],
  [8, "IRIX"],
  [9, "FreeBSD"],
  [10, "Tru64"],
  [12, "FreeBSD"],
  [64, "ARM"],
  [97, "ARM"],
  [255, "Embedded"],
]);

const ELF_TYPES: ReadonlyMap<number, string> = new Map([
  [1, "application/x-object"],
  [2, "application/x-executable"],
  [3, "application/x-sharedlib"],
  [4, "application/x-coredump"],
]);

/** e_machine to the machine type; a value that is not here sets none. */
const ELF_MACHINES: ReadonlyMap<number, string> = new Map([
  [2, MACHINE.sparc],
  [18, MACHINE.sparc],
  [43, MACHINE.sparc],
  [3, MACHINE.x86_32],
  [4, MACHINE.m68k],
  [5, MACHINE.m88k],
  [8, MACHINE.mips],
  [10, MACHINE.mips],
  [7, MACHINE.s370],
  [20, MACHINE.ppc],
  [21, MACHINE.ppc],
  [22, MACHINE.s390],
  [40, MACHINE.arm],
  [41, MACHINE.alpha],
  [0x9026, MACHINE.alpha],
  [50, MACHINE.ia64],
  [62, MACHINE.x86_64],
  [75, MACHINE.vax],
  [88, MACHINE.m32r],
]);

/** ExecutableParser.parseELF, from byte 4 of the file. */
function readElf(reader: HeaderReader, metadata: Metadata): void {
  const architecture = reader.read();
  if (architecture === 1) metadata.set(ARCHITECTURE_BITS, "32");
  else if (architecture === 2) metadata.set(ARCHITECTURE_BITS, "64");

  const endian = reader.read();
  if (endian === 1) metadata.set(ENDIAN, LITTLE);
  else if (endian === 2) metadata.set(ENDIAN, BIG);

  reader.read(); // the ELF version

  // The OS and its ABI version: many compilers set neither.
  const os = reader.read();
  const osVersion = reader.read();
  if (os > 0 || osVersion > 0) {
    const platform = ELF_PLATFORMS.get(os);
    if (platform !== undefined) metadata.set(PLATFORM, platform);
  }

  reader.skipFully(7); // padding

  // Only a byte order of 1 is little-endian; the Java reads every other value as big-endian.
  const little = endian === 1;
  metadata.set(CONTENT_TYPE, ELF_TYPES.get(reader.readUShort(little)) ?? ELF_GENERAL);

  const machine = ELF_MACHINES.get(reader.readUShort(little));
  if (machine !== undefined) metadata.set(MACHINE_TYPE, machine);
}

// ---- Mach-O ----

/** The CPU types the Java switch names; the 64-bit flag (0x01000000) is part of the value. */
const MACHO_CPUS: ReadonlyMap<number, string> = new Map([
  [1, MACHINE.vax],
  [6, MACHINE.m68k],
  [7, MACHINE.x86_32],
  [7 | 0x01000000, MACHINE.x86_64],
  [8, MACHINE.mips],
  [12, MACHINE.arm],
  [12 | 0x01000000, MACHINE.arm],
  [13, MACHINE.m88k],
  [14, MACHINE.sparc],
  [18, MACHINE.ppc],
]);

/** mach_header.filetype to the media type; any other value is the generic Mach-O type. */
const MACHO_TYPES: ReadonlyMap<number, string> = new Map([
  [0x1, "application/x-mach-o-object"],
  [0x2, "application/x-mach-o-executable"],
  [0x3, "application/x-mach-o-fvmlib"],
  [0x4, "application/x-mach-o-core"],
  [0x5, "application/x-mach-o-preload"],
  [0x6, "application/x-mach-o-dylib"],
  [0x7, "application/x-mach-o-dylinker"],
  [0x8, "application/x-mach-o-bundle"],
  [0x9, "application/x-mach-o-dylib-stub"],
  [0xa, "application/x-mach-o-dsym"],
  [0xb, "application/x-mach-o-kext-bundle"],
]);

/** ExecutableParser.parseMachO, from byte 4 of the file; the byte order is the magic's. */
function readMachO(reader: HeaderReader, metadata: Metadata, little: boolean): void {
  metadata.set(ENDIAN, little ? LITTLE : BIG);

  const cpuType = reader.readInt(little);
  // Only 64 is ever set: a 32-bit CPU type leaves the width out.
  if (cpuType >> 24 === 1) metadata.set(ARCHITECTURE_BITS, "64");
  const machine = MACHO_CPUS.get(cpuType);
  if (machine !== undefined) metadata.set(MACHINE_TYPE, machine);

  reader.readInt(little); // the CPU subtype

  metadata.set(CONTENT_TYPE, MACHO_TYPES.get(reader.readInt(little)) ?? MACHO_GENERAL);
}
