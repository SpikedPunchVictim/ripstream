import {
  BodyContentHandler,
  CONTEXT_KEYS,
  MalformedDocumentError,
  MediaType,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
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

interface HeaderField {
  readonly name: string;
  readonly value: string;
}

interface Entity {
  readonly headers: HeaderField[];
  readonly body: Uint8Array;
}

/** RFC 822 / MIME email parser with multipart and message/rfc822 recursion. */
export class MailParser implements Parser {
  readonly name = "RFC822Parser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["message/rfc822", "application/x-eml"].map(
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

    const root = splitEntity(data);
    if (root.headers.length === 0) {
      throw new MalformedDocumentError("Email message has no headers");
    }
    applyMailMetadata(metadata, root.headers);
    classifySecurity(root.headers, metadata);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await renderEntity(root, xhtml, metadata, ctx, 0);
    await xhtml.endDocument();
  }
}

async function renderEntity(
  entity: Entity,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  ctx: ParseContext,
  depth: number,
): Promise<void> {
  if (depth > ctx.limits.maxNodeDepth) {
    throw new LimitExceededError(
      `Mail nesting depth ${depth} exceeds ${ctx.limits.maxNodeDepth}`,
    );
  }
  const contentType = contentTypeOf(entity.headers);
  const type = contentType.type;

  if (type.startsWith("multipart/")) {
    const boundary = contentType.parameters.get("boundary");
    if (boundary === undefined) return;
    // RFC 2046 section 5.1.1 caps boundaries at 70 characters; longer ones make
    // the naive byte search O(body * boundary).
    if (boundary.length > 70) {
      throw new MalformedDocumentError("Multipart boundary exceeds 70 characters");
    }
    for (const part of splitMultipart(entity.body, boundary)) {
      await renderEntity(part, xhtml, metadata, ctx, depth + 1);
    }
    return;
  }

  if (type === "message/rfc822") {
    const nested = splitEntity(entity.body);
    if (nested.headers.length > 0) {
      await renderEntity(nested, xhtml, metadata, ctx, depth + 1);
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

  await dispatchEmbedded(entity, decoded, type, xhtml, ctx, depth);
}

async function dispatchEmbedded(
  entity: Entity,
  body: Uint8Array,
  type: string,
  xhtml: XHTMLContentHandler,
  ctx: ParseContext,
  depth: number,
): Promise<void> {
  const partMetadata = new Metadata();
  partMetadata.set("Content-Type", type);
  const name =
    contentTypeParams(entity.headers).get("name") ??
    dispositionParams(entity.headers).get("filename") ??
    `part-${depth}`;
  partMetadata.set("resourceName", name);
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
    partMetadata.set(
      `X-TIKA:EXCEPTION:${error instanceof Error ? error.constructor.name : "Error"}`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await stream.close();
  }
}

function splitEntity(data: Uint8Array): Entity {
  const separator = indexOf(data, [13, 10, 13, 10]);
  const alternate = indexOf(data, [10, 10]);
  let headerEnd = separator;
  let bodyStart = separator + 4;
  if (separator === -1 || (alternate !== -1 && alternate < separator)) {
    headerEnd = alternate;
    bodyStart = alternate + 2;
  }
  if (headerEnd === -1) {
    return { headers: parseHeaders(data), body: new Uint8Array(0) };
  }
  return {
    headers: parseHeaders(data.subarray(0, headerEnd)),
    body: data.subarray(bodyStart),
  };
}

function parseHeaders(data: Uint8Array): HeaderField[] {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const fields: HeaderField[] = [];
  let current: { name: string; value: string } | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (/^[ \t]/.test(line) && current !== null) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    if (current !== null) fields.push(current);
    current = {
      name: line.slice(0, colon).trim().toLowerCase(),
      value: line.slice(colon + 1).trim(),
    };
  }
  if (current !== null) fields.push(current);
  return fields;
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

function dispositionParams(headers: readonly HeaderField[]): Map<string, string> {
  const value = headerValue(headers, "content-disposition");
  return value === undefined ? new Map() : parseStructured(value).parameters;
}

function parseStructured(value: string): {
  readonly type: string;
  readonly parameters: Map<string, string>;
} {
  const parts = splitParameters(value);
  const type = (parts.shift() ?? "text/plain").toLowerCase();
  const parameters = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    const name = part.slice(0, equals).trim().toLowerCase();
    let parameter = part.slice(equals + 1).trim();
    if (parameter.startsWith('"') && parameter.endsWith('"')) {
      parameter = parameter.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    parameters.set(name, parameter);
  }
  return { type: type.split(";")[0]!.trim(), parameters };
}

function splitParameters(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"' && current.at(-1) !== "\\") quoted = !quoted;
    if (char === ";" && !quoted) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function splitMultipart(body: Uint8Array, boundary: string): Entity[] {
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
      parts.push(splitEntity(body.subarray(segmentStart, segmentEnd)));
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

function decodeHeader(value: string): string {
  return value.replace(
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

function applyMailMetadata(
  metadata: Metadata,
  headers: readonly HeaderField[],
): void {
  const subject = headerValue(headers, "subject");
  if (subject !== undefined) metadata.set("dc:title", decodeHeader(subject));

  const from = headerValue(headers, "from");
  if (from !== undefined) {
    metadata.set("dc:creator", decodeHeader(from));
    metadata.set("Message:From", decodeHeader(from));
  }
  const to = headerValue(headers, "to");
  if (to !== undefined) metadata.set("Message:To", decodeHeader(to));
  const cc = headerValue(headers, "cc");
  if (cc !== undefined) metadata.set("Message:Cc", decodeHeader(cc));
  const messageId = headerValue(headers, "message-id");
  if (messageId !== undefined) metadata.set("Message-ID", messageId.trim());
  const date = headerValue(headers, "date");
  if (date !== undefined) metadata.set("dcterms:created", date.trim());
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
