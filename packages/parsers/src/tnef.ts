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
const SUBJECT = 0x8004;
const BODY = 0x800c;
const BODY_HTML = 0x800d;
const MESSAGE_CLASS = 0x8008;

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
    const subject = attributes.get(SUBJECT);
    const body = attributes.get(BODY);
    const bodyHtml = attributes.get(BODY_HTML);
    const messageClass = attributes.get(MESSAGE_CLASS);
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

function readAttributes(
  data: Uint8Array,
  view: DataView,
  start: number,
): Map<number, string> {
  const attributes = new Map<number, string>();
  let offset = start;
  while (offset + 9 <= data.length) {
    const level = data[offset]!;
    const tag = view.getUint32(offset + 1, true);
    const length = view.getUint32(offset + 5, true);
    offset += 9;
    if (length > data.length - offset) break;
    const value = data.subarray(offset, offset + length);
    offset += length;
    if (level === 1 && [SUBJECT, BODY, BODY_HTML, MESSAGE_CLASS].includes(tag)) {
      attributes.set(
        tag,
        stripTrailingNuls(new TextDecoder("windows-1252").decode(value)).trim(),
      );
    }
  }
  return attributes;
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
