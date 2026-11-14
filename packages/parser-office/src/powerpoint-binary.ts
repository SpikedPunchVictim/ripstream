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
 * The text of every slide and of its notes, as POI's `HSLFSlide.getTextParagraphs` gives it to Tika: a master's
 * non-placeholder text shapes are written before each slide's text, the master placeholder prompts are not text, and a
 * stream edited in PowerPoint has gaps of zeroes between the records of one edit and the next: the newest edit's records
 * are the ones Tika reads, so the slide text is taken from the last block after a gap.
 */
function extractText(stream: Uint8Array, title: string | null): string {
  const state: WalkState = { documentTexts: new Set(), masterPrompts: new Set(), masterText: [], lastGap: -1 };
  walk(stream, 0, stream.byteLength, 0, "document", [], title, state, false, false, 0);
  const parts: string[] = [];
  if (title !== null && title.trim().length > 0) parts.push(title.trim());
  // The records after the last gap are the current edit; if there is none, the whole stream is current.
  const start = state.lastGap > 0 ? state.lastGap : 0;
  walk(stream, start, stream.byteLength, 0, "document", parts, title, state, true, false, 0);
  return parts
    .join("\n")
    .replace(/[\u000b\u000c]/g, "\r")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000e-\u001f]/g, "");
}

type TextContext = "document" | "slide" | "notes" | "master";

interface WalkState {
  /** Text in the document-level copy of a list, which is the master's, not the slide's notes. */
  readonly documentTexts: Set<string>;
  /** The master's placeholder prompts, in whatever language: not slide text. */
  readonly masterPrompts: Set<string>;
  /** The master's non-placeholder text shapes, which Tika writes before every slide's text. */
  readonly masterText: string[];
  /** Where the last zero-filled gap ended, or -1 when the stream has none. Mutated by the collecting pass only. */
  lastGap: number;
}

/** Returns the number of text atoms emitted under this range, so an empty slide list can present its prompt. */
function walk(
  data: Uint8Array,
  start: number,
  end: number,
  depth: number,
  context: TextContext,
  emit: string[],
  title: string | null,
  state: WalkState,
  emitting: boolean,
  placeholder: boolean,
  enclosing: number,
  headerFooterMask: number | null = null,
): number {
  if (depth > MAX_CONTAINER_DEPTH) {
    throw new MalformedDocumentError(
      `PowerPoint container nesting exceeds ${MAX_CONTAINER_DEPTH} levels`,
    );
  }
  let emitted = 0;
  let textHeaderType: number | null = null;
  let position = start;
  while (position + 8 <= end) {
    const versionInstance = readUInt16(data, position);
    const type = readUInt16(data, position + 2);
    const length = readUInt32(data, position + 4);
    if (versionInstance === 0 && type === 0 && length === 0) {
      // A zero-filled gap between the records of an edited stream: the next record starts at the next plausible header.
      const next = nextRecord(data, position + 1, end);
      if (next === -1) break;
      if (!emitting) state.lastGap = Math.max(state.lastGap, next);
      position = next;
      continue;
    }
    if (length > end - position - 8) break;
    const payload = data.subarray(position + 8, position + 8 + length);
    const instance = versionInstance >> 4;

    if (type === TEXT_HEADER_ATOM) {
      textHeaderType = readUInt32(payload, 0);
    } else if (type === TEXT_CHARS_ATOM || type === TEXT_BYTES_ATOM) {
      const value = type === TEXT_CHARS_ATOM
        ? decodeUtf16(payload)
        : new TextDecoder("windows-1252").decode(payload);
      const isText = !value.startsWith("Click to edit");
      const runType = textHeaderType;
      textHeaderType = null;
      if (context === "master" && isText) {
        if (placeholder) state.masterPrompts.add(value);
        else if (!state.masterText.includes(value)) state.masterText.push(value);
      } else if (context === "document" && isText) {
        if (!emitting) state.documentTexts.add(value);
      } else if (isText && !(context === "notes" && runType === 2)) {
        // A notes master body placeholder (run type 2) is a prompt; Tika leaves it out of the notes.
        if (emitting) emit.push(value);
        emitted++;
      }
    } else if (type === CSTRING_ATOM) {
      // A header/footer text is a UTF-16 CString, written only when its atom says it is visible.
      if (enclosing === HEADERS_FOOTERS) {
        const option = versionInstance >> 4;
        const visible = option === 1 ? (headerFooterMask ?? 0) & 16 : option === 2 ? (headerFooterMask ?? 0) & 32 : 0;
        const value = new TextDecoder("utf-16le").decode(payload).replace(/\u0000/g, "");
        if (visible !== 0 && value.trim().length > 0) {
          if (emitting) emit.push(value);
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
      // A placeholder mark lives in the shape's ClientData (f011), beside the textbox (f00d).
      const childPlaceholder = type === 0xf004 ? hasPlaceholderInShape(payload) : placeholder;
      const childMask = type === HEADERS_FOOTERS ? headerFooterMaskOf(payload) : headerFooterMask;
      // A master's non-placeholder text is written before each slide's own text.
      if (emitting && type === SLIDE_CONTAINER && state.masterText.length > 0) {
        for (const value of state.masterText) emit.push(value);
        emitted += state.masterText.length;
      }
      emitted += walk(payload, 0, payload.byteLength, depth + 1, childContext, emit, title, state, emitting, childPlaceholder, type, childMask);
    }

    position += 8 + length;
  }
  return emitted;
}

/** The mask of a HeadersFootersAtom (fda) in a headers/footers container, or null when it has none. */
function headerFooterMaskOf(payload: Uint8Array): number | null {
  let position = 0;
  while (position + 8 <= payload.byteLength) {
    const type = readUInt16(payload, position + 2);
    const length = readUInt32(payload, position + 4);
    if (length > payload.byteLength - position - 8) return null;
    if (type === 0x0fda && length >= 4) return readUInt16(payload, position + 8 + 2);
    position += 8 + length;
  }
  return null;
}

/** Whether a shape's ClientData carries the OEPlaceholderAtom that marks the shape a placeholder. */
function hasPlaceholderInShape(payload: Uint8Array): boolean {
  let position = 0;
  while (position + 8 <= payload.byteLength) {
    const type = readUInt16(payload, position + 2);
    const length = readUInt32(payload, position + 4);
    if (length > payload.byteLength - position - 8) return false;
    if (type === 0xf011) {
      const clientData = payload.subarray(position + 8, position + 8 + length);
      let at = 0;
      while (at + 8 <= clientData.byteLength) {
        const dataType = readUInt16(clientData, at + 2);
        const dataLength = readUInt32(clientData, at + 4);
        if (dataLength > clientData.byteLength - at - 8) break;
        if (dataType === 0x0bc3) return true;
        at += 8 + dataLength;
      }
    }
    position += 8 + length;
  }
  return false;
}

/** The next offset from \`from\` at which a record this reader knows begins and fits, or -1. */
function nextRecord(data: Uint8Array, from: number, end: number): number {
  for (let at = from; at + 8 <= end; at++) {
    const versionInstance = readUInt16(data, at);
    const type = readUInt16(data, at + 2);
    const length = readUInt32(data, at + 4);
    if (length > end - at - 8) continue;
    if ((versionInstance & 0x000f) === CONTAINER_VERSION) {
      if (type === SLIDE_CONTAINER || type === NOTES_CONTAINER || type === MAIN_MASTER_CONTAINER || type === SLIDE_LIST_WITH_TEXT || type === HEADERS_FOOTERS) return at;
      if (type === 0x040c || type === 0x03ef || type === 0x03f1 || type === 0x0fda) return at;
    }
    if (type === TEXT_HEADER_ATOM || type === TEXT_CHARS_ATOM || type === TEXT_BYTES_ATOM || type === CSTRING_ATOM) return at;
  }
  return -1;
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
