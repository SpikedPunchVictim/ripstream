import {
  MalformedDocumentError,
  MediaType,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { XHTMLContentHandler } from "@spikedpunch/ripstream-core";

/** PE/COFF, ELF and Mach-O header description (no disassembly). */
export class ExecutableParser implements Parser {
  readonly name = "ExecutableParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/x-msdownload",
        "application/x-elf",
        "application/x-executable",
        "application/x-mach-o",
        "application/x-mach-o-executable",
        "application/x-mach-o-dylib",
        "application/x-mach-o-bundle",
      ].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const header = describe(data);
    await (async () => {
      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();
      await xhtml.element("h1", header.format);
      for (const line of header.lines) await xhtml.element("p", line);
      await xhtml.endDocument();
    })();
  }
}

interface Description {
  readonly format: string;
  readonly lines: readonly string[];
}

function describe(data: Uint8Array): Description {
  if (data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a) {
    return describePe(data);
  }
  if (
    data.length >= 4 &&
    data[0] === 0x7f &&
    data[1] === 0x45 &&
    data[2] === 0x4c &&
    data[3] === 0x46
  ) {
    return describeElf(data);
  }
  if (data.length >= 4) {
    const magic = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
    if (
      [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)
    ) {
      return describeMachO(data, magic);
    }
  }
  throw new MalformedDocumentError("Unknown executable format");
}

function describePe(data: Uint8Array): Description {
  if (data.length < 0x40) throw new MalformedDocumentError("Truncated PE header");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 26 > data.length) {
    throw new MalformedDocumentError("Truncated PE header");
  }
  const signature = view.getUint32(peOffset, true);
  if (signature !== 0x00004550) {
    throw new MalformedDocumentError("Invalid PE signature");
  }
  const machine = view.getUint16(peOffset + 4, true);
  const characteristics = view.getUint16(peOffset + 22, true);
  const magic = view.getUint16(peOffset + 24, true);
  return {
    format: "PE executable",
    lines: [
      `Machine: ${machineName(machine)}`,
      `Format: ${magic === 0x20b ? "PE32+" : "PE32"}`,
      `Characteristics: 0x${characteristics.toString(16)}`,
    ],
  };
}

function describeElf(data: Uint8Array): Description {
  if (data.length < 20) throw new MalformedDocumentError("Truncated ELF header");
  const bits = data[4] === 2 ? 64 : 32;
  const little = data[5] === 1;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const machine = view.getUint16(18, little);
  return {
    format: "ELF executable",
    lines: [`Class: ELF${bits}`, `Machine: ${elfMachine(machine)}`, `Endianness: ${little ? "little" : "big"}`],
  };
}

function describeMachO(data: Uint8Array, magic: number): Description {
  if (data.length < 8) throw new MalformedDocumentError("Truncated Mach-O header");
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const bits = magic === 0xfeedfacf || magic === 0xcffaedfe ? 64 : 32;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cpu = view.getUint32(4, little);
  return {
    format: "Mach-O executable",
    lines: [`Architecture: ${cpu === 0x01000007 ? "x86_64" : cpu === 0x0100000c ? "arm64" : `0x${cpu.toString(16)}`}`, `Class: ${bits}-bit`],
  };
}

function machineName(machine: number): string {
  switch (machine) {
    case 0x14c: return "x86";
    case 0x8664: return "x86-64";
    case 0xaa64: return "ARM64";
    case 0x1c0: return "ARM";
    default: return `0x${machine.toString(16)}`;
  }
}

function elfMachine(machine: number): string {
  switch (machine) {
    case 3: return "x86";
    case 62: return "x86-64";
    case 183: return "AArch64";
    case 40: return "ARM";
    default: return `0x${machine.toString(16)}`;
  }
}
