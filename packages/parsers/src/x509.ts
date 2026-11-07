import {
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

/** X.509 certificate metadata for PEM and DER inputs. */
export class X509Parser implements Parser {
  readonly name = "X509Parser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/x-x509-ca-cert",
        "application/pkix-cert",
        "application/x-pem-file",
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
    const info = parseCertificate(der);
    metadata.set("x509:subject", info.subject);
    metadata.set("x509:issuer", info.issuer);
    metadata.set("x509:serial", info.serial);
    metadata.set("x509:not-before", info.notBefore);
    metadata.set("x509:not-after", info.notAfter);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.element("p", `Subject: ${info.subject}`);
    await xhtml.element("p", `Issuer: ${info.issuer}`);
    await xhtml.element("p", `Serial: ${info.serial}`);
    await xhtml.element("p", `Not Before: ${info.notBefore}`);
    await xhtml.element("p", `Not After: ${info.notAfter}`);
    await xhtml.endDocument();
  }
}

interface CertificateInfo {
  readonly subject: string;
  readonly issuer: string;
  readonly serial: string;
  readonly notBefore: string;
  readonly notAfter: string;
}

function decodePem(data: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (text.includes("-----BEGIN CERTIFICATE-----")) {
    const body = text
      .replace(/-----BEGIN CERTIFICATE-----/, "")
      .replace(/-----END CERTIFICATE-----/, "")
      .replace(/\s+/g, "");
    return Uint8Array.from(Buffer.from(body, "base64"));
  }
  return data;
}

function parseCertificate(data: Uint8Array): CertificateInfo {
  const certificate = readTlv(data, 0);
  if (certificate === null || certificate.tag !== 0x30) {
    throw new MalformedDocumentError("Invalid certificate");
  }
  const tbs = readTlv(data, certificate.start);
  if (tbs === null || tbs.tag !== 0x30) {
    throw new MalformedDocumentError("Invalid tbsCertificate");
  }
  let position = tbs.start;
  let serial = "";
  let issuer = "";
  let subject = "";
  let notBefore = "";
  let notAfter = "";

  for (let field = 0; field < 8 && position < tbs.end; field++) {
    const tlv = readTlv(data, position);
    if (tlv === null) break;
    if (tlv.tag === 0xa0) {
      position = tlv.end;
      continue;
    }
    if (tlv.tag === 0x02 && serial.length === 0) {
      serial = Buffer.from(data.subarray(tlv.start, tlv.end)).toString("hex");
    } else if (tlv.tag === 0x30) {
      const text = parseName(data, tlv);
      if (issuer.length === 0 && text.includes("=")) issuer = text;
      else if (subject.length === 0 && text.includes("=")) subject = text;
    }
    position = tlv.end;
  }

  for (let position2 = tbs.start; position2 < tbs.end; ) {
    const tlv = readTlv(data, position2);
    if (tlv === null) break;
    if (tlv.tag === 0x30) {
      const times = parseValidity(data, tlv);
      if (times !== null) {
        notBefore = times[0];
        notAfter = times[1];
        break;
      }
    }
    position2 = tlv.end;
  }

  return { subject, issuer, serial, notBefore, notAfter };
}

function parseValidity(data: Uint8Array, sequence: Tlv): [string, string] | null {
  const first = readTlv(data, sequence.start);
  const second = first === null ? null : readTlv(data, first.end);
  if (first === null || second === null) return null;
  if (first.tag !== 0x17 && first.tag !== 0x18) return null;
  return [
    decodeTime(data, first),
    decodeTime(data, second),
  ];
}

function decodeTime(data: Uint8Array, tlv: Tlv): string {
  const value = new TextDecoder("latin1").decode(data.subarray(tlv.start, tlv.end));
  if (tlv.tag === 0x18) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
  }
  const year = Number(value.slice(0, 2));
  const century = year >= 50 ? "19" : "20";
  return `${century}${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}T${value.slice(6, 8)}:${value.slice(8, 10)}:${value.slice(10, 12)}Z`;
}

function parseName(data: Uint8Array, sequence: Tlv): string {
  const parts: string[] = [];
  let position = sequence.start;
  while (position < sequence.end) {
    const set = readTlv(data, position);
    if (set === null) break;
    if (set.tag === 0x31) {
      const pair = readTlv(data, set.start);
      if (pair !== null && pair.tag === 0x30) {
        const oid = readTlv(data, pair.start);
        const value = oid === null ? null : readTlv(data, oid.end);
        if (oid !== null && value !== null) {
          parts.push(`${oidName(decodeOid(data, oid))}=${decodeString(data, value)}`);
        }
      }
    }
    position = set.end;
  }
  return parts.join(", ");
}

function oidName(oid: string): string {
  switch (oid) {
    case "2.5.4.3": return "CN";
    case "2.5.4.6": return "C";
    case "2.5.4.7": return "L";
    case "2.5.4.8": return "ST";
    case "2.5.4.10": return "O";
    case "2.5.4.11": return "OU";
    case "1.2.840.113549.1.9.1": return "emailAddress";
    default: return oid;
  }
}

function decodeOid(data: Uint8Array, tlv: Tlv): string {
  const bytes = data.subarray(tlv.start, tlv.end);
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

function decodeString(data: Uint8Array, tlv: Tlv): string {
  const bytes = data.subarray(tlv.start, tlv.end);
  if (tlv.tag === 0x1e) {
    let result = "";
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      result += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
    }
    return result;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function readTlv(data: Uint8Array, offset: number): Tlv | null {
  if (offset + 2 > data.length) return null;
  const tag = data[offset]!;
  let length = data[offset + 1]!;
  let position = offset + 2;
  if (length === 0x80 || (tag & 0x1f) === 0x1f) return null;
  if ((length & 0x80) !== 0) {
    const bytes = length & 0x7f;
    if (bytes > 4 || position + bytes > data.length) return null;
    length = 0;
    for (let index = 0; index < bytes; index++) {
      length = length * 256 + data[position + index]!;
    }
    position += bytes;
  }
  if (position + length > data.length) return null;
  return { tag, start: position, end: position + length };
}
