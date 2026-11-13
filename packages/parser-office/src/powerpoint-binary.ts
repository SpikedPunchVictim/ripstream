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

const POWERPOINT = "application/vnd.ms-powerpoint";
const TEXT_HEADER_ATOM = 0x0f9f;
const TEXT_CHARS_ATOM = 0x0fa0;
const TEXT_BYTES_ATOM = 0x0fa8;
const CSTRING_ATOM = 0x0fba;
const SLIDE_CONTAINER = 0x03ee;
const NOTES_CONTAINER = 0x03f0;
const MAIN_MASTER_CONTAINER = 0x03f8;
const SLIDE_LIST_WITH_TEXT = 0x0ff0;
const HEADERS_FOOTERS = 0x0fd9;
const CONTAINER_VERSION = 0x000f;
const MAX_CONTAINER_DEPTH = 64;

/** PowerPoint 97-2003 binary (.ppt) text extraction from text atoms. */
export class PowerPointBinaryParser implements Parser {
  readonly name = "PowerPointParser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse(POWERPOINT)!]);
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
      throw new MalformedDocumentError("Not a binary PowerPoint document");
    }
    const compound = CompoundFile.parse(data);
    if (isEncryptedCompound(compound)) {
      throw new EncryptedDocumentError("PowerPoint document is encrypted");
    }
    if (!compound.has("PowerPoint Document")) {
      throw new MalformedDocumentError("Missing PowerPoint Document stream");
    }

    for (const name of ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"]) {
      if (!compound.has(name)) continue;
      try {
        applyPropertySetMetadata(metadata, parsePropertySets(compound.read(name)));
      } catch {
        // Property sets are optional.
      }
    }

    const text = extractText(compound.read("PowerPoint Document"), metadata.get("dc:title"));
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const paragraph of text.split("\n")) {
      const value = paragraph.trim();
      if (value.length === 0) continue;
      await xhtml.startElement("p");
      await xhtml.characters(value);
      await xhtml.endElement("p");
    }
    await xhtml.endDocument();
  }
}

/**
 * The text of every slide and of its notes, as POI's `HSLFSlide.getTextParagraphs` gives it to Tika: the master
 * placeholder prompts ("Click to edit ..."), the CString persist-directory names and the master bodies are not slide
 * text. A slide whose placeholder text is empty presents its prompt; the document title stands in for the first one.
 */
function extractText(stream: Uint8Array, title: string | null): string {
  // Text repeated in the document-level copy of a list is the master's, not the slide's notes.
  const documentTexts = new Set<string>();
  walk(stream, 0, stream.byteLength, 0, "document", [], title, documentTexts);
  const parts: string[] = [];
  // Tika writes the presentation title ahead of the slides (the title placeholder's prompt when it is empty).
  if (title !== null && title.trim().length > 0) parts.push(title.trim());
  walk(stream, 0, stream.byteLength, 0, "document", parts, title, documentTexts);
  return parts
    .join("\n")
    .replace(/[\u000b\u000c]/g, "\r")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000e-\u001f]/g, "");
}

type TextContext = "document" | "slide" | "notes" | "master";

/** Returns the number of text atoms emitted under this range, so an empty slide list can present its prompt. */
function walk(
  data: Uint8Array,
  start: number,
  end: number,
  depth: number,
  context: TextContext,
  emit: string[],
  title: string | null = null,
  documentTexts: Set<string> | null = null,
  listState: { title: boolean } | null = null,
  enclosing = 0,
): number {
  if (depth > MAX_CONTAINER_DEPTH) {
    throw new MalformedDocumentError(
      `PowerPoint container nesting exceeds ${MAX_CONTAINER_DEPTH} levels`,
    );
  }
  let emitted = 0;
  let slideNumber = 0;
  let pendingTextType: number | null = null;
  let position = start;
  while (position + 8 <= end) {
    const versionInstance = readUInt16(data, position);
    const type = readUInt16(data, position + 2);
    const length = readUInt32(data, position + 4);
    if (length > end - position - 8) break;
    const payload = data.subarray(position + 8, position + 8 + length);
    const instance = versionInstance >> 4;

    if (type === TEXT_HEADER_ATOM) {
      pendingTextType = readUInt32(payload, 0);
    } else if (type === TEXT_CHARS_ATOM || type === TEXT_BYTES_ATOM) {
      const value = type === TEXT_CHARS_ATOM
        ? decodeUtf16(payload)
        : new TextDecoder("windows-1252").decode(payload);
      const isText = value !== "*" && !value.startsWith("Click to edit");
      if (isText && context === "slide" && pendingTextType === 0 && listState !== null) listState.title = true;
      pendingTextType = null;
      if (context === "document" && isText) {
        documentTexts?.add(value);
      } else if ((context === "slide" || context === "notes") && isText) {
        // Master placeholders are prompts, in whatever language; Tika leaves them out.
        if (!(context === "notes" && documentTexts?.has(value))) {
          emit.push(value);
          emitted++;
        }
      }
    } else if (type === CSTRING_ATOM) {
      // A header/footer text is a UTF-16 CString; persist-directory names are not text.
      if (enclosing === HEADERS_FOOTERS) {
        const value = new TextDecoder("utf-16le").decode(payload).replace(/\u0000/g, "");
        if (value.trim().length > 0) {
          emit.push(value);
          emitted++;
        }
      }
    } else if ((versionInstance & 0x000f) === CONTAINER_VERSION) {
      const childContext: TextContext =
        type === SLIDE_CONTAINER ? "slide"
        : type === NOTES_CONTAINER ? "notes"
        : type === MAIN_MASTER_CONTAINER ? "master"
        : type === SLIDE_LIST_WITH_TEXT && instance === 0 ? "slide"
        : context;
      const before = emit.length;
      const state = type === SLIDE_LIST_WITH_TEXT && instance === 0 ? { title: false } : listState;
      emitted += walk(payload, 0, payload.byteLength, depth + 1, childContext, emit, title, documentTexts, state, type);
      if (type === SLIDE_LIST_WITH_TEXT && instance === 0 && state !== null) {
        slideNumber++;
        // The title already stands in for an empty title placeholder in decks that have one.
        if (!state.title && (title === null || title.trim().length === 0)) {
          emit.push(`Slide ${slideNumber}`);
          emitted++;
        }
      }
    }

    position += 8 + length;
  }
  return emitted;
}

function decodeUtf16(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    result += String.fromCharCode(readUInt16(bytes, index));
  }
  return result;
}

function readUInt16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readUInt32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    ((data[offset + 3] ?? 0) << 24)
  ) >>> 0;
}
