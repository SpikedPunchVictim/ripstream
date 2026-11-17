import {
  AbortError,
  BodyContentHandler,
  CONTEXT_KEYS,
  LimitExceededError, limitError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  OutputLimitContentHandler,
  ParseTimeoutError,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  TIKA_KEYS,
  XHTMLContentHandler,
  type ContentHandler,
  type Detector,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { detectEncoding } from "@spikedpunch/ripstream-mime";
import { createDecoder } from "./charset.ts";
import { mailHeaderBlock } from "./mail-header-block.ts";
import { renderEmailHtml } from "./mail-html.ts";
import { applyMailMetadata, type HeaderField } from "./mail-metadata.ts";
import { parseStructured } from "./mail-structured.ts";

/**
 * Tika's RFC822Parser builds its mime4j configuration with `setMaxLineLen(100000).setMaxHeaderLen(100000)`: a header block over
 * this many bytes is an error there (a TikaException; a LimitExceededError here).
 */
export const DEFAULT_MAX_MAIL_HEADER_BYTES = 100_000;

export interface MailParserOptions {
  /**
   * Tika's `RFC822Parser.Config.extractAllAlternatives` (default false): every part of a multipart/alternative is read, not
   * only the best one.
   */
  readonly extractAllAlternatives?: boolean;
  /** Maximum bytes in one header block, the message's and each part's (default {@link DEFAULT_MAX_MAIL_HEADER_BYTES}). */
  readonly maxHeaderBytes?: number;
}

/** What rendering a message needs besides the entity: where the text goes, the limits, and the options. */
interface Output {
  readonly xhtml: XHTMLContentHandler;
  readonly metadata: Metadata;
  readonly ctx: ParseContext;
  readonly extractAllAlternatives: boolean;
  readonly maxHeaderBytes: number;
}

/** The multipart an entity is in: what Tika's MailContentHandler tells an embedded part (`multipart:subtype`, `multipart:boundary`). */
interface Container {
  readonly subtype: string;
  readonly boundary: string | undefined;
}

interface Entity {
  readonly headers: HeaderField[];
  readonly body: Uint8Array;
}

/**
 * RFC 822 / MIME email parser with multipart and message/rfc822 recursion.
 *
 * Like Tika's RFC822Parser it also reads Apple Mail's emlx (`message/x-emlx`): a first line carrying the message's byte
 * count, then the message, then an XML plist. See {@link stripEmlxFraming}.
 *
 * Headers become metadata as in Tika's MailContentHandler (see {@link applyMailMetadata}); with `ParseOptions.emailHeaders`
 * the message's header block is also written ahead of the body (see `mailHeaderBlock`). Of a multipart/alternative only the
 * best part is read, unless `extractAllAlternatives` is set. Not yet as Tika does it (tikajs-68os.46 records the rest): a
 * text part that is an attachment, or that sits below the first level of a multipart outside an alternative, is read inline here
 * and is an embedded document in Tika; a message/rfc822 part is read inline and is an embedded document in Tika; the text of
 * a body part is not wrapped in `<div class="email-entry"><p>`; an embedded part gets no Content-Disposition, Content-Encoding
 * or file-system dates.
 */
export class MailParser implements Parser {
  readonly name = "RFC822Parser";
  readonly #extractAllAlternatives: boolean;
  readonly #maxHeaderBytes: number;

  constructor(options: MailParserOptions = {}) {
    const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_MAIL_HEADER_BYTES;
    if (!Number.isInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
      throw new RangeError(`maxHeaderBytes must be a positive integer, got ${maxHeaderBytes}`);
    }
    this.#extractAllAlternatives = options.extractAllAlternatives ?? false;
    this.#maxHeaderBytes = maxHeaderBytes;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["message/rfc822", "message/x-emlx", "application/x-eml"].map(
        (type) => MediaType.parse(type)!,
      ),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
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

    const root = splitEntity(stripEmlxFraming(data), this.#maxHeaderBytes);
    if (root.headers.length === 0) {
      throw new MalformedDocumentError("Email message has no headers");
    }
    applyMailMetadata(metadata, root.headers, decodeHeader);
    classifySecurity(root.headers, metadata);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    const output: Output = {
      xhtml,
      metadata,
      ctx,
      extractAllAlternatives: this.#extractAllAlternatives,
      maxHeaderBytes: this.#maxHeaderBytes,
    };
    const collected: Collected = { bodies: [], attachments: [], nextIndex: 0, nextNested: 0 };
    collectEntity(root, output, 0, undefined, collected, true);

    // xberg's email content: the header block, the body, then an Attachments: summary and the text of each attachment
    // inlined under its name (extractors/email.rs, tikajs-26ut).
    const blocks: string[] = [];
    if (ctx.get(CONTEXT_KEYS.EMAIL_HEADER_BLOCK) !== false) {
      const block = mailHeaderBlock(root.headers, decodeHeader);
      if (block.length > 0) blocks.push(block);
    }
    const body = renderBody(collected);
    if (body.length > 0) blocks.push(body);
    if (collected.attachments.length > 0) {
      blocks.push("Attachments:");
      for (const attachment of collected.attachments) blocks.push(`  ${summaryName(attachment)} (${attachment.size}B)`);
      for (const attachment of collected.attachments) {
        if (attachment.nested) continue;
        const text = await inlineAttachmentText(attachment, output);
        if (text.length > 0) blocks.push(`  ${childName(attachment)}\n${text}`);
      }
    }
    const content = blocks.filter((block) => block.length > 0).join("\n\n");
    if (content.length > 0) await xhtml.characters(content);
    await registerAttachmentChildren(collected.attachments, output);
    await xhtml.endDocument();
  }
}

/** One body part: plain text, or the raw text/html that the renderer turns into xberg's plain body text. */
interface BodyPart {
  readonly kind: "text" | "html";
  readonly text: string;
}

/** A part that is not body text: an attachment, or a message/rfc822 part (child-only in xberg). */
interface AttachmentPart {
  readonly entity: Entity;
  readonly type: string;
  readonly name: string | undefined;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly nested: boolean;
  readonly container: Container | undefined;
  readonly index: number;
  readonly nestedIndex: number;
  detected?: string;
}

/** What an email's parts hold: body parts in the order they came, and the attachments. */
interface Collected {
  bodies: BodyPart[];
  attachments: AttachmentPart[];
  nextIndex: number;
  nextNested: number;
}

const IGNORE_HANDLER: ContentHandler = {
  startDocument: () => undefined,
  endDocument: () => undefined,
  startElement: () => undefined,
  endElement: () => undefined,
  characters: () => undefined,
};

/**
 * Walks the message's parts the way xberg does: body text from the non-attachment text/plain and text/html parts (a
 * multipart/alternative contributes its best part), everything else as an attachment. A message/rfc822 part is a
 * child-only attachment and its body text is folded into the parent's body. `foldOnly` collects body text alone
 * (for that fold), never attachments.
 */
function collectEntity(
  entity: Entity,
  output: Output,
  depth: number,
  container: Container | undefined,
  collected: Collected,
  isRoot: boolean,
  foldOnly = false,
): void {
  if (depth > output.ctx.limits.maxNodeDepth) {
    throw limitError(`Mail nesting depth ${depth} exceeds ${output.ctx.limits.maxNodeDepth}`, "nodeDepth", depth, output.ctx.limits.maxNodeDepth);
  }
  const contentType = contentTypeOf(entity.headers);
  const type = contentType.type;

  if (type === "message/rfc822") {
    if (!foldOnly) collected.attachments.push(makeAttachment(entity, type, container, collected, true));
    const nested = splitEntity(entity.body, output.maxHeaderBytes);
    if (nested.headers.length > 0) collectEntity(nested, output, depth + 1, undefined, collected, true, true);
    return;
  }

  const attachment = !isRoot && isAttachment(entity, type, contentType.parameters);
  if (attachment) {
    if (!foldOnly) collected.attachments.push(makeAttachment(entity, type, container, collected, false));
    return;
  }

  if (type.startsWith("multipart/")) {
    const boundary = contentType.parameters.get("boundary");
    if (boundary === undefined) return;
    if (boundary.length > 70) throw new MalformedDocumentError("Multipart boundary exceeds 70 characters");
    const childContainer: Container = { subtype: type.slice("multipart/".length), boundary };
    const parts = splitMultipart(entity.body, boundary, output.maxHeaderBytes);
    const chosen = type === "multipart/alternative" && !output.extractAllAlternatives ? bestAlternative(parts) : parts;
    for (const part of chosen) collectEntity(part, output, depth + 1, childContainer, collected, false, foldOnly);
    return;
  }

  const decoded = decodeTransfer(entity.body, entity.headers);
  collected.bodies.push({
    kind: type === "text/html" ? "html" : "text",
    text: decodeBodyText(decoded, contentType.parameters.get("charset")),
  });
}

/** A part xberg calls an attachment: a disposition or a name says so, or it is not body text. */
function isAttachment(entity: Entity, type: string, parameters: ReadonlyMap<string, string>): boolean {
  if (dispositionType(entity.headers) === "attachment") return true;
  if (parameters.get("name") !== undefined || dispositionParams(entity.headers).get("filename") !== undefined) return true;
  return !(type.startsWith("text/") || type.startsWith("multipart/") || type === "message/rfc822");
}

function makeAttachment(
  entity: Entity,
  type: string,
  container: Container | undefined,
  collected: Collected,
  nested: boolean,
): AttachmentPart {
  const bytes = decodeTransfer(entity.body, entity.headers);
  const name = dispositionParams(entity.headers).get("filename") ?? contentTypeParams(entity.headers).get("name");
  const attachment: AttachmentPart = {
    entity,
    type,
    name,
    bytes,
    size: bytes.byteLength,
    nested,
    container,
    index: collected.nextIndex,
    nestedIndex: collected.nextNested,
  };
  if (nested) collected.nextNested++;
  else collected.nextIndex++;
  return attachment;
}

function summaryName(attachment: AttachmentPart): string {
  return attachment.name ?? "unnamed";
}

/** The name of the attachment's record (and of its inlined section): the file's name, or a synthetic one. */
function childName(attachment: AttachmentPart): string {
  if (attachment.nested) return `nested_message_${attachment.nestedIndex}.eml`;
  return attachment.name ?? `attachment_${attachment.index}`;
}

/** xberg's plain body text: paragraphs split at a blank line, each trimmed, empty ones dropped (rendering/plain.rs). */
function plainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n\n")
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .join("\n\n");
}

/**
 * The body as xberg writes it: every body part in order, each plain part as paragraphs and each HTML part through the
 * renderer, separated by a blank line. An alternative already contributed only its chosen part.
 */
function renderBody(collected: Collected): string {
  return collected.bodies
    .map((body) => (body.kind === "html" ? renderEmailHtml(body.text) : plainText(body.text)))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** The type the bytes are, by the detector when one is in the context (xberg detects before the declared type). */
async function detectedType(attachment: AttachmentPart, output: Output): Promise<string> {
  if (attachment.detected !== undefined) return attachment.detected;
  const detector = output.ctx.get(CONTEXT_KEYS.DETECTOR) as Detector | undefined;
  if (detector === undefined) return (attachment.detected = attachment.type);
  const metadata = new Metadata();
  if (attachment.name !== undefined) metadata.set(TIKA_KEYS.RESOURCE_NAME, attachment.name);
  const stream = await RipstreamInputStream.from(attachment.bytes, { context: output.ctx });
  try {
    return (attachment.detected = (await detector.detect(stream, metadata, output.ctx)).toString());
  } catch {
    return (attachment.detected = attachment.type);
  } finally {
    await stream.close();
  }
}

/** The text xberg inlines under an attachment's name: its own text, or what a parser reads from it. */
async function inlineAttachmentText(attachment: AttachmentPart, output: Output): Promise<string> {
  if (attachment.nested) return "";
  const type = await detectedType(attachment, output);
  const parameters = contentTypeParams(attachment.entity.headers);
  if (type === "" || type.startsWith("text/plain")) return plainText(decodeBodyText(attachment.bytes, parameters.get("charset")));
  if (type.startsWith("text/html")) return renderEmailHtml(decodeBodyText(attachment.bytes, parameters.get("charset")));
  const parser = output.ctx.get(CONTEXT_KEYS.PARSER) as Parser | undefined;
  if (parser === undefined) return "";
  const partMetadata = new Metadata();
  partMetadata.set("Content-Type", type);
  partMetadata.set(TIKA_KEYS.RESOURCE_NAME, childName(attachment));
  const stream = await RipstreamInputStream.from(attachment.bytes, { context: output.ctx });
  const body = new BodyContentHandler();
  const limited = new OutputLimitContentHandler(body, output.ctx.limits.maxOutputChars);
  try {
    const child = output.ctx.createChild();
    child.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, new ParsingEmbeddedDocumentExtractor());
    await parser.parse(stream, limited, partMetadata, child);
    return body.toString().trim();
  } catch (error) {
    rethrowResiliency(error, output.ctx);
    return "";
  } finally {
    await stream.close();
  }
}

/** Attachments are the message's embedded records; xberg keeps them as children under their own paths. */
async function registerAttachmentChildren(attachments: readonly AttachmentPart[], output: Output): Promise<void> {
  const extractor = output.ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined;
  if (extractor === undefined) return;
  for (const attachment of attachments) {
    const type = attachment.nested ? "message/rfc822" : await detectedType(attachment, output);
    const partMetadata = new Metadata();
    partMetadata.set("Content-Type", type);
    partMetadata.set(TIKA_KEYS.RESOURCE_NAME, childName(attachment));
    partMetadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE, "ATTACHMENT");
    if (attachment.container !== undefined) {
      partMetadata.set("multipart:subtype", attachment.container.subtype);
      if (attachment.container.boundary !== undefined) partMetadata.set("multipart:boundary", attachment.container.boundary);
    }
    const stream = await RipstreamInputStream.from(attachment.bytes, { context: output.ctx });
    try {
      await extractor.parseEmbedded(stream, IGNORE_HANDLER, partMetadata, output.ctx);
      const known = new Set(output.metadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION));
      for (const failure of partMetadata.getAll(TIKA_KEYS.EMBEDDED_EXCEPTION)) {
        if (!known.has(failure)) {
          output.metadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
          known.add(failure);
        }
      }
    } catch (error) {
      rethrowResiliency(error, output.ctx);
      const failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      partMetadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
      output.metadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
    } finally {
      await stream.close();
    }
  }
}

/** A resiliency error reaches the server (422/408); an attachment's ordinary failure is a warning xberg skips. */
function rethrowResiliency(error: unknown, ctx: ParseContext): void {
  if (
    error instanceof LimitExceededError ||
    error instanceof ParseTimeoutError ||
    error instanceof AbortError ||
    ctx.signal.aborted
  ) {
    throw error;
  }
}

// A digit run, Apple Mail's space padding to 10 columns, then the newline: at most 11 bytes (RFC822Parser.EMLX_COUNT_LINE_MAX).
const EMLX_COUNT_LINE_MAX = 11;
const PLIST_START = [0x3c, 0x3f, 0x78, 0x6d, 0x6c]; // "<?xml"

/**
 * Port of RFC822Parser.stripEmlxFraming: drops the byte-count line when the data starts with one, and bounds the message
 * to that count when the plist really starts there. A count that does not land on `<?xml` (an edited file) is not
 * trusted: the message is taken whole, so it is never cut. Only the first 11 bytes are read as a count line.
 */
function stripEmlxFraming(data: Uint8Array): Uint8Array {
  let count = 0;
  let digits = 0;
  let padding = false;
  let lineLength = -1;
  const head = Math.min(data.length, EMLX_COUNT_LINE_MAX);
  for (let index = 0; index < head; index++) {
    const byte = data[index]!;
    if (byte >= 0x30 && byte <= 0x39 && !padding) {
      count = count * 10 + (byte - 0x30);
      digits++;
    } else if (byte === 0x20 && digits > 0) {
      padding = true;
    } else if (byte === 0x0a && digits > 0) {
      lineLength = index + 1;
      break;
    } else {
      break;
    }
  }
  if (lineLength < 0) return data;
  const plistAt = lineLength + count;
  const verified = plistAt + PLIST_START.length <= data.length && PLIST_START.every((byte, offset) => data[plistAt + offset] === byte);
  return verified ? data.subarray(lineLength, plistAt) : data.subarray(lineLength);
}

/** The parts of an alternative that MailContentHandler reads: only the first with the top score. */
function bestAlternative(parts: readonly Entity[]): Entity[] {
  let best: Entity | undefined;
  let bestScore = -1;
  for (const part of parts) {
    const score = alternativeScore(part);
    if (score > bestScore) {
      best = part;
      bestScore = score;
    }
  }
  return best === undefined ? [] : [best];
}

/**
 * MailContentHandler.score: text/plain 1, application/rtf 2, text/html 3, and anything else 4, which includes a part that is
 * itself a multipart. (A part with no Content-Type is text/plain, as in mime4j.)
 */
function alternativeScore(part: Entity): number {
  switch (contentTypeOf(part.headers).type) {
    case "text/plain":
      return 1;
    case "application/rtf":
      return 2;
    case "text/html":
      return 3;
    default:
      return 4;
  }
}

function splitEntity(data: Uint8Array, maxHeaderBytes: number): Entity {
  const separator = indexOf(data, [13, 10, 13, 10]);
  const alternate = indexOf(data, [10, 10]);
  let headerEnd = separator;
  let bodyStart = separator + 4;
  if (separator === -1 || (alternate !== -1 && alternate < separator)) {
    headerEnd = alternate;
    bodyStart = alternate + 2;
  }
  if (headerEnd === -1) {
    return { headers: parseBlock(data, maxHeaderBytes), body: new Uint8Array(0) };
  }
  return {
    headers: parseBlock(data.subarray(0, headerEnd), maxHeaderBytes),
    body: data.subarray(bodyStart),
  };
}

/** The fields of a header block, after checking its size against the cap (RFC822Parser's `setMaxHeaderLen`). */
function parseBlock(block: Uint8Array, maxHeaderBytes: number): HeaderField[] {
  if (block.length > maxHeaderBytes) {
    // Data that does not start like headers at all is the caller's "no headers" error, not a limit: look at the cap's worth.
    if (parseHeaders(block.subarray(0, maxHeaderBytes)).length === 0) return [];
    throw new LimitExceededError(`A mail header block is longer than ${maxHeaderBytes} bytes`);
  }
  return parseHeaders(block);
}

function parseHeaders(data: Uint8Array): HeaderField[] {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const fields: HeaderField[] = [];
  let current: { rawName: string; raw: string } | null = null;

  // Alternating line and line end, so a folded header keeps the line ends it was written with.
  const pieces = text.split(/(\r?\n)/);
  for (let index = 0; index < pieces.length; index += 2) {
    const line = pieces[index]!;
    if (line.length === 0) continue;
    if (/^[ \t]/.test(line) && current !== null) {
      current.raw += `${pieces[index - 1] ?? ""}${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    if (current !== null) fields.push(headerField(current));
    current = { rawName: line.slice(0, colon).trim(), raw: line.slice(colon + 1).replace(/^[ \t]+/, "") };
  }
  if (current !== null) fields.push(headerField(current));
  return fields;
}

function headerField(field: { rawName: string; raw: string }): HeaderField {
  return {
    name: field.rawName.toLowerCase(),
    rawName: field.rawName,
    raw: field.raw,
    value: field.raw.replace(/\r?\n(?=[ \t])/g, "").trim(),
  };
}

function headerValue(
  headers: readonly HeaderField[],
  name: string,
): string | undefined {
  return headers.find((header) => header.name === name)?.value;
}

function contentTypeOf(headers: readonly HeaderField[]): {
  readonly type: string;
  readonly parameters: Map<string, string>;
} {
  const value = headerValue(headers, "content-type") ?? "text/plain";
  return parseStructured(value);
}

function contentTypeParams(headers: readonly HeaderField[]): Map<string, string> {
  return contentTypeOf(headers).parameters;
}

function dispositionType(headers: readonly HeaderField[]): string | undefined {
  const value = headerValue(headers, "content-disposition");
  return value === undefined ? undefined : parseStructured(value).type;
}

function dispositionParams(headers: readonly HeaderField[]): Map<string, string> {
  const value = headerValue(headers, "content-disposition");
  return value === undefined ? new Map() : parseStructured(value).parameters;
}

/**
 * A part of a multipart body, which starts after the delimiter's line break. A part that has no headers has its blank line
 * first, and what follows is its body (RFC 2046 section 5.1.1); splitEntity would look for a blank line further on.
 */
function splitPart(data: Uint8Array, maxHeaderBytes: number): Entity {
  if (data[0] === 0x0d && data[1] === 0x0a) return { headers: [], body: data.subarray(2) };
  if (data[0] === 0x0a) return { headers: [], body: data.subarray(1) };
  return splitEntity(data, maxHeaderBytes);
}

/**
 * The next delimiter line at or after `from`: `--boundary` at the start of a line and followed by `--` (the closing
 * delimiter) or by optional spaces and the line end, so a boundary that is the prefix of a nested one (`part` and
 * `part_alt`) or that merely occurs inside text is not taken for one (RFC 2046 section 5.1.1).
 */
function findDelimiter(body: Uint8Array, marker: readonly number[], from: number): number {
  let at = indexOf(body, marker, from);
  while (at !== -1) {
    if (at === 0 || body[at - 1] === 0x0a) {
      let after = at + marker.length;
      if (body[after] === 0x2d && body[after + 1] === 0x2d) return at;
      while (body[after] === 0x20 || body[after] === 0x09) after++;
      if (after >= body.length || body[after] === 0x0a || body[after] === 0x0d) return at;
    }
    at = indexOf(body, marker, at + 1);
  }
  return -1;
}

function splitMultipart(body: Uint8Array, boundary: string, maxHeaderBytes: number): Entity[] {
  const marker = Array.from(encodeLatin1(`--${boundary}`));
  const parts: Entity[] = [];
  let start = findDelimiter(body, marker, 0);
  while (start !== -1) {
    let segmentStart = start + marker.length;
    // Closing delimiter ("--boundary--") ends the multipart body.
    if (body[segmentStart] === 0x2d && body[segmentStart + 1] === 0x2d) break;
    const next = findDelimiter(body, marker, segmentStart);
    let segmentEnd = next === -1 ? body.length : next;
    // The line break before a delimiter belongs to the delimiter (RFC 2046 5.1.1), not to the part that precedes it.
    if (next !== -1 && segmentEnd > 0 && body[segmentEnd - 1] === 0x0a) {
      segmentEnd -= segmentEnd > 1 && body[segmentEnd - 2] === 0x0d ? 2 : 1;
    }
    // Spaces after the delimiter are transport padding, not part of the part.
    while (body[segmentStart] === 0x20 || body[segmentStart] === 0x09) segmentStart++;
    if (body[segmentStart] === 0x0d && body[segmentStart + 1] === 0x0a) {
      segmentStart += 2;
    } else if (body[segmentStart] === 0x0a) {
      segmentStart += 1;
    }
    if (segmentEnd > segmentStart) {
      parts.push(splitPart(body.subarray(segmentStart, segmentEnd), maxHeaderBytes));
    }
    start = next;
  }
  return parts;
}

function decodeTransfer(body: Uint8Array, headers: readonly HeaderField[]): Uint8Array {
  const encoding = (headerValue(headers, "content-transfer-encoding") ?? "")
    .trim()
    .toLowerCase();
  if (encoding === "base64") {
    const text = new TextDecoder("latin1").decode(body).replace(/\s+/g, "");
    try {
      return decodeBase64(text);
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  return body;
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, "");
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    if (char === "=") break;
    const value = BASE64.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

/**
 * Quoted-printable as mime4j decodes it: a soft line break (`=` at the end of a line) is dropped, and a hard line break, LF
 * or CRLF, is written as CRLF with the spaces and tabs before it dropped (an encoded `=20` before it stays), so a CR that
 * the text has as `=0D` comes out before a CRLF.
 */
function decodeQuotedPrintable(body: Uint8Array): Uint8Array {
  const output: number[] = [];
  // Output below this index is a decoded escape, or the end of a line: trailing white space is only that of the encoded text.
  let keep = 0;
  for (let index = 0; index < body.length; index++) {
    const byte = body[index]!;
    if (byte === 0x0a || (byte === 0x0d && body[index + 1] === 0x0a)) {
      while (output.length > keep && (output[output.length - 1] === 0x20 || output[output.length - 1] === 0x09)) output.pop();
      output.push(0x0d, 0x0a);
      keep = output.length;
      if (byte === 0x0d) index++;
      continue;
    }
    if (byte !== 0x3d) {
      output.push(byte);
      continue;
    }
    const next = body[index + 1];
    if (next === 0x0d && body[index + 2] === 0x0a) {
      index += 2;
      continue;
    }
    if (next === 0x0a) {
      index += 1;
      continue;
    }
    const high = hexValue(next);
    const low = hexValue(body[index + 2]);
    if (high >= 0 && low >= 0) {
      output.push(high * 16 + low);
      keep = output.length;
      index += 2;
    } else {
      output.push(byte);
    }
  }
  return new Uint8Array(output);
}

function hexValue(value: number | undefined): number {
  if (value === undefined) return -1;
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return -1;
}

/**
 * The text of a mail body part. Tika 4.2.0 decodes it with its usual detection, to which the part's charset is the
 * declaration: it is used when the bytes can be in it, and not when they cannot (a part labelled utf-8 or us-ascii that
 * holds windows-1252 bytes), where the statistical answer is taken; bytes that are valid UTF-8 are UTF-8 whatever the label
 * (measured: a windows-1252 part with UTF-8 bytes reads as UTF-8). A part without a charset is detected the same way.
 */
function decodeBodyText(data: Uint8Array, label: string | undefined): string {
  const charset = detectEncoding(data.subarray(0, 64 * 1024), label).charset;
  return createDecoder(charset).decoder.decode(data);
}

function decodeCharset(data: Uint8Array, charset: string): string {
  // createDecoder reads UTF-32, and falls back to UTF-8 for a label it does not know.
  return createDecoder(normalizeCharset(charset)).decoder.decode(data);
}

function normalizeCharset(charset: string): string {
  const name = charset.trim().toLowerCase();
  if (name === "utf8") return "utf-8";
  if (name === "latin1" || name === "iso-8859-1") return "windows-1252";
  if (name === "us-ascii" || name === "ascii") return "utf-8";
  return name;
}

// RFC 2047 section 6.2: white space between two encoded words is not part of the text.
const BETWEEN_ENCODED_WORDS = /(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)[ \t\r\n]+(?==\?[^?\s]+\?[bBqQ]\?)/g;

function decodeHeader(value: string): string {
  return value.replace(BETWEEN_ENCODED_WORDS, "$1").replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (match, charset: string, encoding: string, text: string) => {
      try {
        if (encoding.toLowerCase() === "b") {
          return decodeCharset(decodeBase64(text), charset);
        }
        const bytes = decodeQuotedPrintable(
          encodeLatin1(text.replace(/_/g, " ")),
        );
        return decodeCharset(bytes, charset);
      } catch {
        return match;
      }
    },
  );
}

function classifySecurity(
  headers: readonly HeaderField[],
  metadata: Metadata,
): void {
  const contentType = (headerValue(headers, "content-type") ?? "").toLowerCase();
  const transfer = (headerValue(headers, "content-transfer-encoding") ?? "").toLowerCase();
  if (contentType.startsWith("multipart/signed") || contentType.startsWith("application/pkcs7-mime")) {
    metadata.set("Message:Security", "smime");
  } else if (
    contentType.startsWith("multipart/encrypted") ||
    contentType.startsWith("application/pgp-encrypted")
  ) {
    metadata.set("Message:Security", "pgp");
  } else if (transfer === "base64" && contentType.startsWith("application/octet-stream")) {
    metadata.set("Message:Security", "unknown-binary");
  }
}

function encodeLatin1(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function indexOf(
  data: Uint8Array,
  needle: readonly number[],
  from = 0,
): number {
  const limit = data.length - needle.length;
  for (let start = from; start <= limit; start++) {
    let matched = true;
    for (let index = 0; index < needle.length; index++) {
      if (data[start + index] !== needle[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}
