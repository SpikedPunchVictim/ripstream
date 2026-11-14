import {
  MediaType,
  Metadata,
  parseXmpPacket,
  recordStreamException,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { scanXmpPacket } from "./xmp-packet-scanner.ts";

/**
 * Tika's JXLParser: JPEG XL is scanned for an `<?xpacket?>`-wrapped XMP packet and the packet is mapped to metadata.
 * The image pixels are not decoded. A malformed packet is recorded and swallowed, as ImageXmp does for every image.
 */
export class JxlParser implements Parser {
  readonly name = "JXLParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("image/jxl")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    _handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    try {
      const packet = await scanXmpPacket(stream);
      if (packet === null) return;
      applyXmp(new TextDecoder("utf-8", { fatal: false }).decode(packet), metadata);
    } catch (error) {
      recordStreamException(metadata, error);
    }
  }
}

/** The packet's mapped keys: dc's rdf:Alt/Bag/Seq values under the dc key, every other direct element by name. */
function applyXmp(xml: string, metadata: Metadata): void {
  const raw = parseXmpPacket(xml);
  for (const name of raw.names()) {
    if (name.startsWith("rdf:") || name.startsWith("xmlns:") || name.startsWith("xml:")) continue;
    for (const value of raw.getAll(name)) metadata.add(name, value);
  }
  for (const [name, property] of [
    ["dc:title", "dc:title"],
    ["dc:creator", "dc:creator"],
    ["dc:description", "dc:description"],
    ["dc:subject", "dc:subject"],
  ] as const) {
    const block = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
    if (block === undefined) continue;
    for (const match of block.matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/g)) {
      const value = decode(match[1]!);
      if (value.length > 0) metadata.add(property, value);
    }
  }
}

function decode(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
