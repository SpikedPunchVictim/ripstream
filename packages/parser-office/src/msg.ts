import {
  CONTEXT_KEYS,
  EncryptedDocumentError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  TIKA_KEYS,
  XHTMLContentHandler,
  type Attributes,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { readAll } from "./bytes.ts";
import { CompoundFile, hasSignature, isEncryptedCompound } from "./cfb.ts";
import { describeFailure, isFatal } from "./failures.ts";
import { applyPropertySetMetadata, parsePropertySets } from "./property-sets.ts";
import { decompressRtf } from "./rtf-compressed.ts";

const OUTLOOK = "application/vnd.ms-outlook";
const PREFIX = "__substg1.0_";
const ATTACHMENT_PREFIX = "__attach_version1.0_#";

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
    ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);

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

    const get = (tag: string): string | undefined => stringOf(compound, "", tag);

    assign(metadata, "dc:title", get("0037"));
    assign(metadata, "dc:creator", get("0C1F") ?? get("0C1A"));
    assign(metadata, "Message:To", get("0E04"));
    assign(metadata, "Message:Cc", get("0E03"));
    assign(metadata, "Message-ID", get("1035"));

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
    await writeBody(compound, xhtml, ctx);
    await writeAttachments(compound, xhtml, metadata, ctx);
    await xhtml.endDocument();
  }
}

/** Tika's OutlookExtractor body: the HTML stream if there is one (even empty), else a non-empty compressed RTF, else the text. */
async function writeBody(compound: CompoundFile, xhtml: XHTMLContentHandler, ctx: ParseContext): Promise<void> {
  const hasParser = ctx.get(CONTEXT_KEYS.PARSER) !== undefined;
  const html = bytesOf(compound, "", "1013");
  if (html !== undefined && hasParser) return writeParsed(html, "text/html", xhtml, ctx);
  const compressed = bytesOf(compound, "", "1009");
  if (compressed !== undefined && compressed.byteLength > 0 && hasParser) {
    const rtf = decompressRtf(compressed, ctx.limits.maxEmbeddedResourceBytes);
    if (rtf === undefined) throw new MalformedDocumentError("Invalid compression signature in the message's RTF body");
    return writeParsed(rtf, "application/rtf", xhtml, ctx);
  }
  const text = stringOf(compound, "", "1000");
  if (text === undefined || text.length === 0) return;
  await xhtml.startElement("p");
  await xhtml.characters(text);
  await xhtml.endElement("p");
}

/** The body parsed (a name hint makes the bytes HTML or RTF whatever they look like) into the message's own XHTML. */
async function writeParsed(bytes: Uint8Array, type: string, xhtml: XHTMLContentHandler, ctx: ParseContext): Promise<void> {
  if (bytes.byteLength === 0) return;
  const hint = new Metadata();
  hint.set(TIKA_KEYS.RESOURCE_NAME, type === "text/html" ? "body.html" : "body.rtf");
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    await (ctx.get(CONTEXT_KEYS.PARSER) as Parser).parse(stream, new BodyForwarder(xhtml, type === "text/html"), hint, ctx.createChild());
  } finally {
    await stream.close();
  }
}

/**
 * Elements Tika's output ends with one newline, not the two that the message's handler adds on top of the parsed HTML's own (it
 * does write two for p, h1 to h6, pre, lists, table, blockquote and address). Read off Tika 4.2.0 element by element.
 */
const SINGLE_LINE_ELEMENTS: ReadonlySet<string> = new Set(["div", "br", "form", "fieldset", "hr", "select", "option"]);

/**
 * What a parsed document puts inside its <body>, as `new BodyContentHandler(xhtml)` passes it on in Tika. `elements` false
 * forwards the text only: an RTF paragraph ends in the one newline its own parser writes.
 */
class BodyForwarder implements ContentHandler {
  readonly #target: XHTMLContentHandler;
  readonly #elements: boolean;
  #depth = 0;
  #inBody = false;

  constructor(target: XHTMLContentHandler, elements: boolean) {
    this.#target = target;
    this.#elements = elements;
  }

  startDocument(): void {}
  endDocument(): void {}

  async startElement(uri: string, localName: string, qName: string, attributes: Attributes): Promise<void> {
    this.#depth++;
    if (this.#depth === 2 && localName === "body") this.#inBody = true;
    else if (this.#forwards(localName)) await this.#target.startElement(uri, localName, qName, attributes);
  }

  async endElement(uri: string, localName: string, qName: string): Promise<void> {
    if (this.#depth === 2) this.#inBody = false;
    else if (this.#forwards(localName)) await this.#target.endElement(uri, localName, qName);
    this.#depth--;
  }

  async characters(ch: string, start: number, length: number): Promise<void> {
    if (this.#inBody) await this.#target.characters(ch, start, length);
  }

  async ignorableWhitespace(ch: string, start: number, length: number): Promise<void> {
    if (this.#inBody) await this.#target.ignorableWhitespace(ch, start, length);
  }

  #forwards(localName: string): boolean {
    return this.#inBody && this.#elements && !SINGLE_LINE_ELEMENTS.has(localName);
  }
}

/** Each attachment with data: an attachment-entry with its name, then the data to the embedded-document extractor. */
async function writeAttachments(
  compound: CompoundFile,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  const storages = compound.entries
    .filter((entry) => entry.type === "storage" && entry.name.startsWith(ATTACHMENT_PREFIX))
    .map((entry) => entry.path)
    .sort();
  for (const path of storages) {
    const data = bytesOf(compound, path, "3701");
    if (data === undefined) continue;
    const longName = stringOf(compound, path, "3707");
    const displayName = stringOf(compound, path, "3001");
    const shortName = stringOf(compound, path, "3704");
    const name = [longName, displayName, shortName].find((value) => value !== undefined && value.length > 0);

    const part = new Metadata();
    if (name !== undefined) part.set(TIKA_KEYS.RESOURCE_NAME, name);
    for (const [key, value] of [
      ["mime", stringOf(compound, path, "370E")],
      ["display-name", displayName],
      ["long-file-name", longName],
      ["extension", stringOf(compound, path, "3703")],
      ["file-name", shortName],
    ] as const) {
      assign(part, `mapi:attach:${key}`, value);
    }

    if (name !== undefined) {
      await xhtml.startElement("div", "class", "attachment-entry");
      await xhtml.characters(name);
      await xhtml.endElement("div");
    }
    const extractor =
      (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
      new ParsingEmbeddedDocumentExtractor();
    if (!extractor.shouldParseEmbedded(part)) continue;
    const stream = await RipstreamInputStream.from(data, { context: ctx });
    try {
      await xhtml.startElement("div", "class", "embedded");
      try {
        await extractor.parseEmbedded(stream, xhtml, part, ctx);
      } catch (error) {
        if (isFatal(error, ctx)) throw error;
        const failure = describeFailure(error);
        part.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
        metadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
      }
      await xhtml.endElement("div");
    } finally {
      await stream.close();
    }
  }
}

/** A substream of the root (`dir` "") or of an attachment storage, by tag and type. */
function streamOf(compound: CompoundFile, dir: string, tag: string, type: string): Uint8Array | undefined {
  const path = `${dir === "" ? "" : `${dir}/`}${PREFIX}${tag}${type}`;
  return compound.has(path) ? compound.read(path) : undefined;
}

/** A property as bytes: binary or 8-bit as stored, UTF-16 text as UTF-8. */
function bytesOf(compound: CompoundFile, dir: string, tag: string): Uint8Array | undefined {
  const binary = streamOf(compound, dir, tag, "0102") ?? streamOf(compound, dir, tag, "001E");
  if (binary !== undefined) return binary;
  const unicode = streamOf(compound, dir, tag, "001F");
  return unicode === undefined ? undefined : new TextEncoder().encode(decodeProperty(unicode, "001F"));
}

function stringOf(compound: CompoundFile, dir: string, tag: string): string | undefined {
  const unicode = streamOf(compound, dir, tag, "001F");
  if (unicode !== undefined) return decodeProperty(unicode, "001F");
  const eightBit = streamOf(compound, dir, tag, "001E");
  return eightBit === undefined ? undefined : decodeProperty(eightBit, "001E");
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

function assign(metadata: Metadata, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim().length > 0) metadata.set(key, value.trim());
}
