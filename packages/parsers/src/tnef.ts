import {
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

const SIGNATURE = 0x223e9f78;
// MS-OXTNEF attribute ids: the LOW word of the 32-bit attribute tag is the id
// (the high word is the attribute type, e.g. attSubject = 0x00018004).
const ATT_SUBJECT = 0x8004;
const ATT_BODY = 0x800c;
const ATT_MESSAGE_CLASS = 0x8008;
const ATT_MSG_PROPS = 0x9003;
const LEVEL_MESSAGE = 1;

// MAPI properties carried inside attMsgProps.
const PR_SUBJECT = 0x0037;
const PR_BODY = 0x1000;
const PR_BODY_HTML = 0x1013;

const PT_STRING8 = 0x001e;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;
const PT_OBJECT = 0x000d;
const MV_FLAG = 0x1000;

/** Fixed-size MAPI value lengths in bytes (already 4-byte aligned in TNEF). */
const FIXED_SIZES = new Map<number, number>([
  [0x0002, 4], // PT_SHORT (padded)
  [0x0003, 4], // PT_LONG
  [0x0004, 4], // PT_FLOAT
  [0x0005, 8], // PT_DOUBLE
  [0x0006, 8], // PT_CURRENCY
  [0x0007, 8], // PT_APPTIME
  [0x000a, 4], // PT_ERROR
  [0x000b, 4], // PT_BOOLEAN (padded)
  [0x0014, 8], // PT_I8
  [0x0040, 8], // PT_SYSTIME
  [0x0048, 16], // PT_CLSID
]);

/** TNEF (winmail.dat) subject/body extraction from tagged attributes. */
export class TnefParser implements Parser {
  readonly name = "TNEFParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/vnd.ms-tnef")!]);
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
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 6 || view.getUint32(0, true) !== SIGNATURE) {
      throw new MalformedDocumentError("Not a TNEF file");
    }
    const attributes = readAttributes(data, view, 6);
    const subject = attributes.strings.get(ATT_SUBJECT) ?? attributes.props.get(PR_SUBJECT);
    const body = attributes.strings.get(ATT_BODY) ?? attributes.props.get(PR_BODY);
    const bodyHtml = attributes.props.get(PR_BODY_HTML);
    const messageClass = attributes.strings.get(ATT_MESSAGE_CLASS);
    if (subject !== undefined) metadata.set("dc:title", subject);
    if (messageClass !== undefined) metadata.set("tnef:message-class", messageClass);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    if (subject !== undefined) await xhtml.element("h1", subject);
    const text = body ?? (bodyHtml === undefined ? "" : stripHtml(bodyHtml));
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length > 0) await xhtml.element("p", line);
    }
    await xhtml.endDocument();
  }
}

interface TnefAttributes {
  /** Simple string attributes keyed by attribute id. */
  readonly strings: Map<number, string>;
  /** String/binary MAPI properties from attMsgProps keyed by property id. */
  readonly props: Map<number, string>;
}

function readAttributes(
  data: Uint8Array,
  view: DataView,
  start: number,
): TnefAttributes {
  const result: TnefAttributes = { strings: new Map(), props: new Map() };
  let offset = start;
  // level(1) + tag(4) + length(4); each attribute is followed by a 2-byte checksum.
  while (offset + 9 <= data.length) {
    const level = data[offset]!;
    const id = view.getUint32(offset + 1, true) & 0xffff;
    const length = view.getUint32(offset + 5, true);
    offset += 9;
    if (length > data.length - offset) break;
    const value = data.subarray(offset, offset + length);
    offset += length + 2;
    if (level !== LEVEL_MESSAGE) continue;
    if (id === ATT_SUBJECT || id === ATT_BODY || id === ATT_MESSAGE_CLASS) {
      result.strings.set(id, decodeString(value));
    } else if (id === ATT_MSG_PROPS) {
      readMapiProperties(value, result.props);
    }
  }
  return result;
}

function decodeString(value: Uint8Array): string {
  return stripTrailingNuls(new TextDecoder("windows-1252").decode(value)).trim();
}

/** Reads the subject/body MAPI properties from an attMsgProps blob. */
function readMapiProperties(data: Uint8Array, props: Map<number, string>): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 4) return;
  const count = view.getUint32(0, true);
  let offset = 4;
  for (let index = 0; index < count; index++) {
    if (offset + 4 > data.length) return;
    const rawType = view.getUint16(offset, true);
    const id = view.getUint16(offset + 2, true);
    offset += 4;
    if (id >= 0x8000) {
      // Named property: GUID(16) + kind(4) + (LID(4) | name length(4) + UTF-16 padded to 4).
      if (offset + 20 > data.length) return;
      const kind = view.getUint32(offset + 16, true);
      offset += 20;
      if (kind === 0) {
        offset += 4;
      } else {
        if (offset + 4 > data.length) return;
        const nameLength = view.getUint32(offset, true);
        offset += 4 + align4(nameLength);
      }
      if (offset > data.length) return;
    }

    const multiValue = (rawType & MV_FLAG) !== 0;
    const type = rawType & ~MV_FLAG;
    const fixed = FIXED_SIZES.get(type);
    const variable =
      type === PT_STRING8 || type === PT_UNICODE || type === PT_BINARY || type === PT_OBJECT;
    if (fixed === undefined && !variable) return; // unknown type: cannot stay aligned

    let valueCount = 1;
    if (multiValue || variable) {
      if (offset + 4 > data.length) return;
      valueCount = view.getUint32(offset, true);
      offset += 4;
    }
    for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
      if (fixed !== undefined) {
        offset += fixed;
        if (offset > data.length) return;
        continue;
      }
      if (offset + 4 > data.length) return;
      const length = view.getUint32(offset, true);
      offset += 4;
      if (length > data.length - offset) return;
      const bytes = data.subarray(offset, offset + length);
      offset += align4(length);
      if (valueIndex === 0 && !multiValue && (id === PR_SUBJECT || id === PR_BODY || id === PR_BODY_HTML)) {
        if (type === PT_UNICODE) {
          props.set(id, stripTrailingNuls(new TextDecoder("utf-16le").decode(bytes)).trim());
        } else if (type === PT_STRING8 || type === PT_BINARY) {
          props.set(id, decodeString(bytes));
        }
      }
    }
  }
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function stripHtml(value: string): string {
  // Linear scan; the old [\s\S]*? and <[^>]+> regexes were quadratic on
  // many unclosed "<script" / "<" markers. Failed searches are memoised.
  const scriptClose = /<\/script/gi;
  const styleClose = /<\/style/gi;
  let scriptMissing = false;
  let styleMissing = false;
  let gtMissing = false;
  let out = "";
  let index = 0;
  while (index < value.length) {
    const lt = value.indexOf("<", index);
    if (lt === -1) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, lt);
    const head = value.slice(lt + 1, lt + 7).toLowerCase();
    const rawClose =
      head === "script" && !scriptMissing
        ? scriptClose
        : head.startsWith("style") && !styleMissing
          ? styleClose
          : null;
    if (rawClose !== null) {
      rawClose.lastIndex = lt;
      const close = rawClose.exec(value);
      if (close === null) {
        if (rawClose === scriptClose) scriptMissing = true;
        else styleMissing = true;
      } else {
        const gt = value.indexOf(">", close.index);
        if (gt !== -1) {
          index = gt + 1;
          continue;
        }
        // No ">" follows this close tag, so none follows any later close tag
        // either (later closes are at or after this one): memoise like the
        // missing-close case instead of rescanning for every later opener.
        if (rawClose === scriptClose) scriptMissing = true;
        else styleMissing = true;
      }
    }
    const gt = gtMissing ? -1 : value.indexOf(">", lt + 2);
    if (gt === -1) {
      gtMissing = true;
      out += value.slice(lt, lt + 1);
      index = lt + 1;
      continue;
    }
    out += " ";
    index = gt + 1;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Linear trailing-NUL strip (a /\0+$/ regex is quadratic on long NUL runs). */
function stripTrailingNuls(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end--;
  return value.slice(0, end);
}
