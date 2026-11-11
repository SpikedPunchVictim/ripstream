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

/**
 * Generic DER inspector for PKCS#12 and PKCS#7 certificate bundles: OIDs, strings and integers. Not a Tika parser; pkcs7-mime
 * and pkcs7-signature are Pkcs7Parser's (tikajs-68os.70).
 */
export class Asn1Parser implements Parser {
  readonly name = "ASN1Parser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/x-pkcs12",
        "application/x-pkcs7-certificates",
      ].map((type) => MediaType.parse(type)!),
    );
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
    const der = decodePem(data);
    const lines: string[] = [];
    try {
      walk(der, 0, der.length, lines, 0);
    } catch (error) {
      throw new MalformedDocumentError("Malformed DER", { cause: error });
    }
    if (lines.length === 0) throw new MalformedDocumentError("Empty DER structure");

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const line of lines) {
      if (line.startsWith("OID ")) metadata.add("asn1:oid", line.slice(4));
      await xhtml.element("p", line);
    }
    await xhtml.endDocument();
  }
}

function decodePem(data: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  // Linear scan: a lazy [\s\S]*? regex rescans to EOF from every BEGIN marker.
  const begin = text.indexOf("-----BEGIN ");
  if (begin === -1) return data;
  const headerEnd = text.indexOf("-----", begin + 11);
  if (headerEnd <= begin + 11) return data;
  const bodyStart = headerEnd + 5;
  const bodyEnd = text.indexOf("-----END ", bodyStart);
  if (bodyEnd === -1) return data;
  return Uint8Array.from(
    Buffer.from(text.slice(bodyStart, bodyEnd).replace(/\s+/g, ""), "base64"),
  );
}

function walk(
  data: Uint8Array,
  start: number,
  end: number,
  lines: string[],
  depth: number,
): void {
  if (depth > 64) return;
  let offset = start;
  while (offset + 2 <= end) {
    const tag = data[offset]!;
    let length = data[offset + 1]!;
    let position = offset + 2;
    if (length === 0x80) return;
    if ((length & 0x80) !== 0) {
      const bytes = length & 0x7f;
      if (bytes > 4 || position + bytes > end) return;
      length = 0;
      for (let index = 0; index < bytes; index++) {
        length = length * 256 + data[position + index]!;
      }
      position += bytes;
    }
    if (position + length > end) return;
    if ((tag & 0x20) !== 0) {
      walk(data, position, position + length, lines, depth + 1);
    } else if (tag === 0x06) {
      lines.push(`OID ${decodeOid(data.subarray(position, position + length))}`);
    } else if ([0x0c, 0x13, 0x16, 0x1a].includes(tag)) {
      const value = new TextDecoder("utf-8", { fatal: false })
        .decode(data.subarray(position, position + length))
        .trim();
      if (value.length > 0) lines.push(`String ${value}`);
    } else if (tag === 0x02) {
      const hex = Buffer.from(data.subarray(position, position + length)).toString("hex");
      if (hex.length <= 64) lines.push(`Integer 0x${hex}`);
    }
    offset = position + length;
  }
}

function decodeOid(bytes: Uint8Array): string {
  const parts: number[] = [];
  let value = 0;
  for (const byte of bytes) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  const first = parts.shift() ?? 0;
  return [Math.floor(first / 40), first % 40, ...parts].join(".");
}
