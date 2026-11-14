import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { CompoundFile, hasSignature } from "./cfb.ts";
import { applyPropertySetMetadata, parsePropertySets } from "./property-sets.ts";

const TYPES: Record<string, string[]> = {
  "application/x-mspublisher": ["Contents", "Escher"],
  "application/vnd.visio": ["VisioDocument"],
  "application/vnd.ms-project": ["MSProject"],
  "application/x-msaccess": [],
  "application/x-ms-owner": [],
  "application/onenote": [],
  "application/x-msi": [],
};

/** Metadata/best-effort text for legacy Microsoft formats without a full object model. */
export class LegacyOfficeParser implements Parser {
  readonly name = "LegacyOfficeParser";
  readonly capabilities = { requiresRandomAccess: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(Object.keys(TYPES).map((type) => MediaType.parse(type)!));
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
    const strings: string[] = [];

    if (hasSignature(data)) {
      const compound = CompoundFile.parse(data);
      for (const name of ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"]) {
        if (!compound.has(name)) continue;
        try {
          applyPropertySetMetadata(metadata, parsePropertySets(compound.read(name)));
        } catch {
          // Optional metadata.
        }
      }
      if (type === "application/x-mspublisher" && compound.has("Quill/QuillSub/CONTENTS")) {
        // Publisher text lives in the Quill CONTENTS stream as UTF-16LE text chunks; the other streams are binary.
        appendStrings(strings, utf16Runs(compound.read("Quill/QuillSub/CONTENTS")));
      } else {
        for (const entry of compound.entries) {
          if (entry.type !== "stream") continue;
          appendStrings(strings, printableStrings(compound.read(entry.path)));
        }
      }
    } else if (type.startsWith("application/onenote")) {
      appendStrings(strings, printableStrings(data));
    } else if (type === "application/x-msaccess") {
      const signature = new TextDecoder("latin1").decode(data.subarray(4, 20));
      if (!signature.startsWith("Standard Jet DB")) {
        throw new MalformedDocumentError("Not an Access database");
      }
      metadata.set("access:engine", signature.trim());
      appendStrings(strings, printableStrings(data));
    } else {
      throw new MalformedDocumentError("Unsupported legacy Office container");
    }

    const values = [...new Set(strings)]
      .filter((value) => value.length >= 4)
      .slice(0, 500);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const value of values) await xhtml.element("p", value);
    await xhtml.endDocument();
  }
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

/**
 * Runs of printable ASCII in a UTF-16LE byte stream, kept only where a paragraph ends (CR or LF). Publisher stores
 * its text chunks that way; the font tables' names are length-prefixed and are not paragraphs.
 */
function utf16Runs(data: Uint8Array): string[] {
  const runs: string[] = [];
  let current = "";
  for (let index = 0; index + 1 < data.length; index += 2) {
    const code = data[index]! | (data[index + 1]! << 8);
    if (code >= 0x20 && code <= 0x7e) {
      current += String.fromCharCode(code);
    } else {
      const next = data[index + 2]! | (data[index + 3]! << 8);
      if (current.trim().length > 0 && code === 0x0d && next === 0x0a) runs.push(current.trim());
      current = "";
    }
  }
  if (current.trim().length > 0) runs.push(current.trim());
  return runs;
}

function printableStrings(data: Uint8Array): string[] {
  const strings: string[] = [];
  const ascii = new TextDecoder("latin1").decode(data);
  for (const match of ascii.matchAll(/[ -~]{4,}/g)) strings.push(match[0]!.trim());
  let utf16 = "";
  for (let index = 0; index + 1 < data.length; index += 2) {
    const code = data[index]! | (data[index + 1]! << 8);
    if (code >= 0x20 && code !== 0xffff) utf16 += String.fromCharCode(code);
    else {
      if (utf16.length >= 4) strings.push(utf16);
      utf16 = "";
    }
  }
  if (utf16.length >= 4) strings.push(utf16);
  return strings;
}
