import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParserDeclinedError,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip } from "./bounded-unzip.ts";

const TYPES = [
  "application/vnd.apple.keynote",
  "application/vnd.apple.pages",
  "application/vnd.apple.numbers",
  "application/vnd.apple.iwork",
];

/** iWork '13+ IWA metadata and best-effort strings. */
export class IWork13Parser implements Parser {
  readonly name = "IWork13PackageParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(TYPES.map((type) => MediaType.parse(type)!));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
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
    const files = boundedUnzip(data, ctx.limits);
    const iwa = files.names.filter(
      (name) => name.startsWith("Index/") && name.endsWith(".iwa"),
    );
    if (iwa.length === 0) throw new ParserDeclinedError("Not an iWork 13+ package");
    metadata.set("iwork:iwa-parts", String(iwa.length));
    metadata.set(
      "iwork:preview",
      files.names.some((name) => name.startsWith("QuickLook/Preview")) ? "true" : "false",
    );

    const snappy = (await import("snappyjs")) as unknown as {
      default?: { uncompress?: (value: Uint8Array) => Uint8Array };
      uncompress?: (value: Uint8Array) => Uint8Array;
    };
    const uncompress = snappy.default?.uncompress ?? snappy.uncompress;
    const strings: string[] = [];
    for (const name of iwa.slice(0, 64)) {
      const bytes = files.get(name)!;
      try {
        const decoded = uncompress === undefined ? bytes : decodeIwa(bytes, uncompress);
        appendStrings(strings, printable(decoded));
      } catch (error) {
        if (error instanceof LimitExceededError) throw error; // cap must stay a loud 422
        appendStrings(strings, printable(bytes));
      }
    }
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const value of [...new Set(strings)].slice(0, 500)) {
      await xhtml.element("p", value);
    }
    await xhtml.endDocument();
  }
}

function decodeIwa(
  data: Uint8Array,
  uncompress: (value: Uint8Array) => Uint8Array,
): Uint8Array {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const length = data[offset + 1]! | (data[offset + 2]! << 8) | (data[offset + 3]! << 16);
    offset += 4;
    if (length <= 0 || offset + length > data.length) break;
    pieces.push(uncompress(data.subarray(offset, offset + length)));
    offset += length;
  }
  if (pieces.length === 0) return data;
  let total = 0;
  for (const piece of pieces) total += piece.byteLength;
  const result = new Uint8Array(total);
  let position = 0;
  for (const piece of pieces) {
    result.set(piece, position);
    position += piece.byteLength;
  }
  return result;
}

const MAX_STRINGS = 1_000_000;

function appendStrings(target: string[], source: readonly string[]): void {
  for (const value of source) {
    if (target.length >= MAX_STRINGS) {
      throw new LimitExceededError(`Extracted string count exceeds ${MAX_STRINGS}`);
    }
    target.push(value);
  }
}

function printable(data: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(data);
  return [...text.matchAll(/[ -~]{5,}/g)]
    .map((match) => match[0]!.trim())
    .filter((value) => /[A-Za-z]/.test(value));
}
