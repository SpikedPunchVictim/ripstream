import {
  BodyContentHandler,
  CONTEXT_KEYS,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  TIKA_KEYS,
  XHTMLContentHandler,
  LimitExceededError,
  ParseTimeoutError,
  AbortError,
  type ContentHandler,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { HtmlDocumentParser } from "./html.ts";
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
 * Headers become metadata as in Tika's MailContentHandler (see {@link applyMailMetadata}). Of a multipart/alternative only the
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
    const output: Output = {
      xhtml,
      metadata,
      ctx,
      extractAllAlternatives: this.#extractAllAlternatives,
      maxHeaderBytes: this.#maxHeaderBytes,
    };
    await xhtml.startDocument();
    await renderEntity(root, output, 0, undefined);
    await xhtml.endDocument();
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

async function renderEntity(entity: Entity, output: Output, depth: number, container: Container | undefined): Promise<void> {
  const { xhtml, ctx } = output;
  if (depth > ctx.limits.maxNodeDepth) {
    throw new LimitExceededError(
      `Mail nesting depth ${depth} exceeds ${ctx.limits.maxNodeDepth}`,
    );
  }
  const contentType = contentTypeOf(entity.headers);
  const type = contentType.type;

  if (type.startsWith("multipart/")) {
    await renderMultipart(entity, type, contentType.parameters.get("boundary"), output, depth);
    return;
  }

  if (type === "message/rfc822") {
    const nested = splitEntity(entity.body, output.maxHeaderBytes);
    if (nested.headers.length > 0) {
      await renderEntity(nested, output, depth + 1, container);
    }
    return;
  }

  const decoded = decodeTransfer(entity.body, entity.headers);
  const charset = contentType.parameters.get("charset") ?? "utf-8";
  if (type === "text/plain" || type === "") {
    const text = decodeCharset(decoded, charset);
    if (text.length > 0) await xhtml.characters(text);
    return;
  }
  if (type === "text/html") {
    const childMetadata = new Metadata();
    childMetadata.set("Content-Type", type);
    const captured = new BodyContentHandler();
    const stream = await RipstreamInputStream.from(decoded, { context: ctx });
    try {
      await new HtmlDocumentParser().parse(
        stream,
        captured,
        childMetadata,
        ctx.createChild(),
      );
    } finally {
      await stream.close();
    }
    const text = captured.toString();
    if (text.length > 0) await xhtml.characters(text);
    return;
  }

  await dispatchEmbedded(entity, decoded, type, output, depth, container);
}

async function renderMultipart(entity: Entity, type: string, boundary: string | undefined, output: Output, depth: number): Promise<void> {
  if (boundary === undefined) return;
  // RFC 2046 section 5.1.1 caps boundaries at 70 characters; longer ones make
  // the naive byte search O(body * boundary).
  if (boundary.length > 70) {
    throw new MalformedDocumentError("Multipart boundary exceeds 70 characters");
  }
  const container: Container = { subtype: type.slice("multipart/".length), boundary };
  const parts = splitMultipart(entity.body, boundary, output.maxHeaderBytes);
  const chosen = type === "multipart/alternative" && !output.extractAllAlternatives ? bestAlternative(parts) : parts;
  for (const part of chosen) {
    await renderEntity(part, output, depth + 1, container);
  }
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

async function dispatchEmbedded(
  entity: Entity,
  body: Uint8Array,
  type: string,
  output: Output,
  depth: number,
  container: Container | undefined,
): Promise<void> {
  const { xhtml, ctx } = output;
  const partMetadata = new Metadata();
  partMetadata.set("Content-Type", type);
  if (container !== undefined) {
    partMetadata.set("multipart:subtype", container.subtype);
    if (container.boundary !== undefined) partMetadata.set("multipart:boundary", container.boundary);
  }
  const name =
    contentTypeParams(entity.headers).get("name") ??
    dispositionParams(entity.headers).get("filename") ??
    `part-${depth}`;
  partMetadata.set("tk:resource-name", name);
  // Tika's MailContentHandler: `inline` is INLINE; `attachment`, no disposition and any other fall to ATTACHMENT.
  partMetadata.set(
    TIKA_KEYS.EMBEDDED_RESOURCE_TYPE,
    dispositionType(entity.headers) === "inline" ? "INLINE" : "ATTACHMENT",
  );
  const subject = headerValue(entity.headers, "subject");
  if (subject !== undefined) partMetadata.set("dc:title", decodeHeader(subject));

  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as
      | EmbeddedDocumentExtractor
      | undefined) ?? new ParsingEmbeddedDocumentExtractor();
  const stream = await RipstreamInputStream.from(body, { context: ctx });
  try {
    await extractor.parseEmbedded(stream, xhtml, partMetadata, ctx);
  } catch (error) {
    // Resiliency errors must reach the server (422/408) instead of becoming a 200.
    if (
      error instanceof LimitExceededError ||
      error instanceof ParseTimeoutError ||
      error instanceof AbortError ||
      ctx.signal.aborted
    ) {
      throw error;
    }
    // The part's metadata is dropped by a plain parse, so the message carries the marker too, as Tika's
    // CompositeParser.recordEmbeddedMetadata puts each failed child's exception on the container.
    const failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    partMetadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
    output.metadata.add(TIKA_KEYS.EMBEDDED_EXCEPTION, failure);
  } finally {
    await stream.close();
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

function splitMultipart(body: Uint8Array, boundary: string, maxHeaderBytes: number): Entity[] {
  const marker = Array.from(encodeLatin1(`--${boundary}`));
  const parts: Entity[] = [];
  let start = indexOf(body, marker, 0);
  while (start !== -1) {
    let segmentStart = start + marker.length;
    // Closing delimiter ("--boundary--") ends the multipart body.
    if (body[segmentStart] === 0x2d && body[segmentStart + 1] === 0x2d) break;
    const next = indexOf(body, marker, segmentStart);
    const segmentEnd = next === -1 ? body.length : next;
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

function decodeQuotedPrintable(body: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < body.length; index++) {
    const byte = body[index]!;
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

function decodeCharset(data: Uint8Array, charset: string): string {
  const encoding = normalizeCharset(charset);
  try {
    return new TextDecoder(encoding).decode(data);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }
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
