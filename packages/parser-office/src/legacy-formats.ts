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

interface Signature {
  readonly types: readonly string[];
  readonly magic: readonly number[] | string;
  readonly format: string;
  /** The Content-Type the document reports whichever of `types` it was parsed as (ChmParser sets it the same way). */
  readonly reportedType?: string;
}

const FORMATS: readonly Signature[] = [
  { types: ["application/x-hwp", "application/x-hwp-v5"], magic: "HWP Document File", format: "HWP" },
  { types: ["application/winhlp"], magic: [0x3f, 0x5f], format: "WinHelp" },
  // ChmParser.SUPPORTED_TYPES: the two aliases are not in Tika's MIME database, so only a caller's Content-Type reaches them.
  {
    types: ["application/vnd.ms-htmlhelp", "application/chm", "application/x-chm"],
    magic: "ITSF",
    format: "CHM",
    reportedType: "application/vnd.ms-htmlhelp",
  },
  { types: ["application/x-tika-staroffice", "application/x-staroffice-template"], magic: [0xd0, 0xcf, 0x11, 0xe0], format: "StarOffice" },
];

/** Best-effort text/metadata for legacy formats without full object models. */
export class LegacyFormatParser implements Parser {
  readonly name = "LegacyFormatParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(FORMATS.flatMap((format) => format.types).map((type) => MediaType.parse(type)!));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const type = metadata.get("Content-Type") ?? "";
    const format = FORMATS.find((candidate) => candidate.types.includes(type));
    if (format === undefined || !matches(data, format.magic)) {
      throw new MalformedDocumentError("Unrecognized legacy format");
    }
    metadata.set("legacy:format", format.format);
    if (format.reportedType !== undefined) metadata.set("Content-Type", format.reportedType);
    const strings = printableStrings(data).slice(0, 500);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const value of strings) await xhtml.element("p", value);
    await xhtml.endDocument();
  }
}

function matches(data: Uint8Array, magic: readonly number[] | string): boolean {
  if (typeof magic === "string") {
    return new TextDecoder("latin1").decode(data.subarray(0, magic.length)) === magic;
  }
  return magic.every((byte, index) => data[index] === byte);
}

function printableStrings(data: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(data);
  return [...text.matchAll(/[ -~]{4,}/g)].map((match) => match[0]!.trim());
}
