import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

const TAG_NAMES: Record<number, string> = {
  1: "Encrypted Session Key",
  2: "Signature",
  3: "Symmetric Key Encrypted Session",
  5: "Secret Key",
  6: "Public Key",
  7: "Secret Subkey",
  8: "Compressed Data",
  9: "Symmetrically Encrypted Data",
  11: "Literal Data",
  13: "User ID",
  14: "Public Subkey",
  18: "Sym. Encrypted Integrity Protected",
};

/** OpenPGP packet-level metadata (keys, user IDs, message type). */
export class OpenPgpParser implements Parser {
  readonly name = "OpenPGPParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/pgp-keys",
        "application/pgp-encrypted",
        "application/pgp-signature",
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
    const binary = decodeArmor(data);
    const packets = readPackets(binary);
    if (packets.length === 0) throw new MalformedDocumentError("No OpenPGP packets");
    const lines: string[] = [];
    for (const packet of packets) {
      const name = TAG_NAMES[packet.tag] ?? `Tag ${packet.tag}`;
      metadata.add("pgp:packet", name);
      if (packet.tag === 13) {
        const user = new TextDecoder("utf-8", { fatal: false }).decode(packet.body).trim();
        if (user.length > 0) {
          metadata.add("pgp:user-id", user);
          lines.push(`User ID: ${user}`);
        }
      } else if (packet.tag === 6 || packet.tag === 5 || packet.tag === 14 || packet.tag === 7) {
        if (packet.body.length >= 6 && packet.body[0] === 4) {
          const view = new DataView(packet.body.buffer, packet.body.byteOffset, packet.body.byteLength);
          metadata.add("pgp:key-version", "4");
          metadata.add("pgp:key-algorithm", String(packet.body[5]));
          metadata.add("pgp:key-created", new Date(view.getUint32(1) * 1000).toISOString());
        }
        lines.push(name);
      } else {
        lines.push(name);
      }
    }
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const line of lines) await xhtml.element("p", line);
    await xhtml.endDocument();
  }
}

const MAX_PACKETS = 10_000;

interface Packet {
  readonly tag: number;
  readonly body: Uint8Array;
}

function decodeArmor(data: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  // Linear scan: a lazy [\s\S]*? regex is quadratic with many BEGIN markers.
  const begin = text.indexOf("-----BEGIN ");
  if (begin === -1) return data;
  const headerEnd = text.indexOf("-----", begin + 11);
  if (headerEnd <= begin + 11) return data;
  const bodyStart = headerEnd + 5;
  const bodyEnd = text.indexOf("-----END ", bodyStart);
  if (bodyEnd === -1) return data;
  // RFC 4880 armor: [headers] blank-line, base64 lines, optional "=CRC24" line.
  const lines = text.slice(bodyStart, bodyEnd).split(/\r?\n/);
  // Skip the rest of the BEGIN line, then armor headers (up to first blank line).
  let index = 1;
  const blank = lines.findIndex((line, i) => i >= 1 && line.trim() === "");
  if (blank !== -1 && lines.slice(1, blank).every((line) => line.includes(":"))) {
    index = blank + 1;
  }
  const base64 = lines
    .slice(index)
    // CRC24 is "=" + 4 base64 chars; a bare "="/"==" line is base64 padding.
    .filter((line) => !/^=[A-Za-z0-9+/]{4}\s*$/.test(line))
    .join("")
    .replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function readPackets(data: Uint8Array): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 2 <= data.length) {
    const first = data[offset]!;
    if ((first & 0x80) === 0) break;
    let tag: number;
    let length: number;
    if ((first & 0x40) !== 0) {
      tag = first & 0x3f;
      const value = data[offset + 1]!;
      if (value < 192) {
        length = value;
        offset += 2;
      } else if (value < 224) {
        if (offset + 3 > data.length) break;
        length = ((value - 192) << 8) + data[offset + 2]! + 192;
        offset += 3;
      } else if (value === 255) {
        if (offset + 6 > data.length) break;
        length = new DataView(data.buffer, data.byteOffset).getUint32(offset + 2);
        offset += 6;
      } else break;
    } else {
      tag = (first >> 2) & 0x0f;
      const lengthType = first & 0x03;
      offset += 1;
      if (lengthType === 0) {
        if (offset + 1 > data.length) break;
        length = data[offset]!;
        offset += 1;
      } else if (lengthType === 1) {
        if (offset + 2 > data.length) break;
        length = new DataView(data.buffer, data.byteOffset).getUint16(offset);
        offset += 2;
      } else if (lengthType === 2) {
        if (offset + 4 > data.length) break;
        length = new DataView(data.buffer, data.byteOffset).getUint32(offset);
        offset += 4;
      } else break;
    }
    if (length < 0 || offset + length > data.length) break;
    if (packets.length >= MAX_PACKETS) {
      throw new LimitExceededError(`OpenPGP packet count exceeds ${MAX_PACKETS}`);
    }
    packets.push({ tag, body: data.subarray(offset, offset + length) });
    offset += length;
  }
  return packets;
}
