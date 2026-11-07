import {
  EncryptedDocumentError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { CompoundFile, hasSignature, isEncryptedCompound } from "./cfb.ts";
import { applyPropertySetMetadata, parsePropertySets } from "./property-sets.ts";

const OUTLOOK = "application/vnd.ms-outlook";
const PREFIX = "__substg1.0_";

interface MsgProperty {
  readonly tag: string;
  readonly type: string;
  readonly value: string;
}

/** Outlook .msg extraction from MAPI substg streams. */
export class MsgParser implements Parser {
  readonly name = "MsgParser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse(OUTLOOK)!]);
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

    if (!hasSignature(data)) {
      throw new MalformedDocumentError("Not an Outlook message");
    }
    const compound = CompoundFile.parse(data);
    if (isEncryptedCompound(compound)) {
      throw new EncryptedDocumentError("Encrypted Outlook messages are not supported");
    }
    if (!compound.has("__properties_version1.0")) {
      throw new MalformedDocumentError("Not an Outlook message");
    }

    const properties = readProperties(compound);
    const get = (tag: string): string | undefined =>
      properties.find((property) => property.tag === tag)?.value;

    assign(metadata, "dc:title", get("0037"));
    assign(metadata, "dc:creator", get("0C1F") ?? get("0C1A"));
    assign(metadata, "Message:To", get("0E04"));
    assign(metadata, "Message:Cc", get("0E03"));
    assign(metadata, "Message-ID", get("1035"));
    assign(metadata, "dcterms:created", formatFiletime(get("0039")));

    for (const name of ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"]) {
      if (!compound.has(name)) continue;
      try {
        applyPropertySetMetadata(metadata, parsePropertySets(compound.read(name)));
      } catch {
        // Property sets are optional.
      }
    }

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const body = get("1000") ?? "";
    for (const line of body.split(/\r?\n/)) {
      const value = line.trimEnd();
      if (value.length === 0) continue;
      await xhtml.startElement("p");
      await xhtml.characters(value);
      await xhtml.endElement("p");
    }
    await xhtml.endDocument();
  }
}

function readProperties(compound: CompoundFile): MsgProperty[] {
  const properties: MsgProperty[] = [];
  for (const entry of compound.entries) {
    if (entry.type !== "stream" || !entry.name.startsWith(PREFIX)) continue;
    const key = entry.name.slice(PREFIX.length);
    if (key.length < 8) continue;
    const tag = key.slice(0, 4);
    const type = key.slice(4, 8);
    const bytes = compound.read(entry.path);
    properties.push({ tag, type, value: decodeProperty(bytes, type) });
  }
  return properties;
}

function decodeProperty(bytes: Uint8Array, type: string): string {
  if (type === "001F") {
    let value = "";
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const code = bytes[index]! | (bytes[index + 1]! << 8);
      if (code === 0) break;
      value += String.fromCharCode(code);
    }
    return value;
  }
  if (type === "001E") {
    const zero = bytes.indexOf(0);
    return new TextDecoder("windows-1252").decode(
      zero === -1 ? bytes : bytes.subarray(0, zero),
    );
  }
  return "";
}

function formatFiletime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value;
}

function assign(metadata: Metadata, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim().length > 0) metadata.set(key, value.trim());
}
