import {
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { parseBuffer } from "bplist-parser";
import { SaxesParser } from "saxes";
import { readAll } from "./util.ts";

/** Apple property list parser for XML and binary plists. */
export class PlistParser implements Parser {
  readonly name = "PListParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/x-plist",
        "application/x-bplist",
        "application/x-itunes-bplist",
        // PListParser.SUPPORTED_TYPES also names the three subtypes BPListDetector gives a binary plist by its root keys.
        // They are not in Tika's MIME database, so only the detector or a caller's Content-Type reaches them. The parser
        // reads the bytes, not the type, so a variant is parsed as any other binary plist (Tika does the same).
        "application/x-bplist-itunes",
        "application/x-bplist-memgraph",
        "application/x-bplist-webarchive",
      ].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const data = await readAll(stream);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    if (startsWith(data, "bplist")) {
      try {
        assertBplistExpansionBounded(data);
        const [parsed] = parseBuffer(Buffer.from(data));
        await xhtml.element("p", JSON.stringify(parsed, dataAsBase64));
      } catch (error) {
        if (error instanceof LimitExceededError || error instanceof MalformedDocumentError) {
          throw error;
        }
        throw new MalformedDocumentError("Invalid binary plist", { cause: error });
      }
    } else {
      const lines = xmlPlistLines(new TextDecoder("utf-8", { fatal: false }).decode(data));
      for (const line of lines) await xhtml.element("p", line);
    }

    await xhtml.endDocument();
  }
}

/**
 * JSON.stringify replacer that writes an NSData value as its base64 text, which is what Tika's PListParser does
 * (`handleData` writes `getBase64EncodedData()`). Buffer.toJSON runs before a replacer and would otherwise leave
 * `{"type":"Buffer","data":[...]}`, four characters or more per byte: a real web archive then overruns the output limit.
 * The replacer reads the original value from its holder, because `value` is already the toJSON form.
 */
function dataAsBase64(this: unknown, key: string, value: unknown): unknown {
  const original = (this as Record<string, unknown>)[key];
  return Buffer.isBuffer(original) ? original.toString("base64") : value;
}

const VALUE_TAGS = new Set([
  "key",
  "string",
  "integer",
  "real",
  "date",
  "data",
]);

function xmlPlistLines(xml: string): string[] {
  const lines: string[] = [];
  let collecting = false;
  let current = "";
  const parser = new SaxesParser({ xmlns: false });

  parser.on("opentag", (tag) => {
    const name = tag.name.toLowerCase();
    if (VALUE_TAGS.has(name)) {
      collecting = true;
      current = "";
    } else if (name === "true" || name === "false") {
      lines.push(`${name}`);
    }
  });
  parser.on("text", (text) => {
    if (collecting) current += text;
  });
  parser.on("closetag", (tag) => {
    const name = tag.name.toLowerCase();
    if (VALUE_TAGS.has(name) && collecting) {
      const value = current.trim();
      if (value.length > 0) lines.push(value);
      collecting = false;
      current = "";
    }
  });
  parser.write(xml).close();
  return lines;
}

function startsWith(data: Uint8Array, prefix: string): boolean {
  const bytes = new TextEncoder().encode(prefix);
  if (data.length < bytes.length) return false;
  return bytes.every((byte, index) => data[index] === byte);
}

/**
 * Cap on materialized nodes (every reference followed counts, so a shared child is
 * counted once per parent). bplist-parser already caps distinct objects at 32768, so
 * 1M is ~30x any legitimate expansion, yet keeps work and memory in the tens of MB.
 */
const MAX_EXPANDED_NODES = 1_000_000;
/**
 * Cap on materialized string/data payload (chars or bytes, per reference followed).
 * Data is charged 4x: Buffer.toJSON still materializes one array element per byte before dataAsBase64 swaps it for text.
 */
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const BPLIST_HEADER_LENGTH = 8;
const BPLIST_TRAILER_LENGTH = 32;

/**
 * Pre-pass that bounds the cost of bplist-parser before it runs. A binary plist is a
 * graph of object references, and a hostile file can point many references at the same
 * nested container (billion-laughs), so a tiny file expands to exponentially many nodes.
 * This walks the same graph iteratively WITHOUT materializing anything, charging one
 * node per reference followed, and throws LimitExceededError once the budget is spent.
 * Work and memory are O(MAX_EXPANDED_NODES). Reference cycles never terminate on their
 * own, so they also end in LimitExceededError. Every read is bounds-checked; a bad
 * trailer or offset is a MalformedDocumentError.
 */
function assertBplistExpansionBounded(data: Uint8Array): void {
  const malformed = (why: string) => new MalformedDocumentError(`Invalid binary plist: ${why}`);
  const trailerStart = data.length - BPLIST_TRAILER_LENGTH;
  if (data.length < BPLIST_HEADER_LENGTH + BPLIST_TRAILER_LENGTH) throw malformed("too short");
  if (new TextDecoder("latin1").decode(data.subarray(0, BPLIST_HEADER_LENGTH)) !== "bplist00") {
    throw malformed("unsupported header");
  }

  /** Big-endian unsigned read of `size` bytes at `pos`, within [0, limit). */
  const readUint = (pos: number, size: number, limit: number): number => {
    if (size < 1 || size > 8 || pos < 0 || pos + size > limit) throw malformed("read out of range");
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + data[pos + i]!;
    if (!Number.isSafeInteger(value)) throw malformed("integer too large");
    return value;
  };

  const offsetSize = data[trailerStart + 6]!;
  const refSize = data[trailerStart + 7]!;
  if (offsetSize < 1 || offsetSize > 8) throw malformed("bad offset size");
  if (refSize < 1 || refSize > 8) throw malformed("bad object reference size");
  const numObjects = readUint(trailerStart + 8, 8, data.length);
  const topObject = readUint(trailerStart + 16, 8, data.length);
  const tableOffset = readUint(trailerStart + 24, 8, data.length);
  // Every object needs at least one byte, so more objects than input bytes is impossible.
  if (numObjects < 1 || numObjects > data.length) throw malformed("implausible object count");
  if (topObject >= numObjects) throw malformed("top object out of range");
  if (tableOffset < BPLIST_HEADER_LENGTH || tableOffset + numObjects * offsetSize > trailerStart) {
    throw malformed("offset table out of range");
  }

  /** Decode the marker's count (inline nibble or a following int object). */
  const readCount = (pos: number, info: number): { count: number; next: number } => {
    if (info !== 0x0f) return { count: info, next: pos + 1 };
    const intMarker = data[pos + 1];
    if (intMarker === undefined || intMarker >> 4 !== 0x1) throw malformed("bad length marker");
    const width = 1 << (intMarker & 0x0f);
    return { count: readUint(pos + 2, width, trailerStart), next: pos + 2 + width };
  };

  const stack: number[] = [topObject];
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const index = stack.pop()!;
    if (++nodes > MAX_EXPANDED_NODES) {
      throw new LimitExceededError(`Binary plist expands past ${MAX_EXPANDED_NODES} nodes`);
    }
    const position = readUint(tableOffset + index * offsetSize, offsetSize, trailerStart);
    if (position < BPLIST_HEADER_LENGTH || position >= trailerStart) throw malformed("bad offset");
    const marker = data[position]!;
    const type = marker >> 4;
    const info = marker & 0x0f;
    switch (type) {
      case 0x4: // data
      case 0x5: // ASCII string
      case 0x6: {
        // UTF-16 string
        const { count, next } = readCount(position, info);
        const payload = type === 0x6 ? count * 2 : count;
        if (next + payload > trailerStart) throw malformed("payload out of range");
        bytes += type === 0x4 ? payload * 4 : payload;
        if (bytes > MAX_EXPANDED_BYTES) {
          throw new LimitExceededError("Binary plist expands past the payload budget");
        }
        break;
      }
      case 0xa: // array
      case 0xc: // set
      case 0xd: {
        // dict: keys then values
        const { count, next } = readCount(position, info);
        const refs = type === 0xd ? count * 2 : count;
        if (next + refs * refSize > trailerStart) throw malformed("references out of range");
        // Charge before pushing so the stack itself can never exceed the budget.
        if (nodes + stack.length + refs > MAX_EXPANDED_NODES) {
          throw new LimitExceededError(`Binary plist expands past ${MAX_EXPANDED_NODES} nodes`);
        }
        for (let i = 0; i < refs; i++) {
          const ref = readUint(next + i * refSize, refSize, trailerStart);
          if (ref >= numObjects) throw malformed("reference out of range");
          stack.push(ref);
        }
        break;
      }
      default:
        break; // fixed-size leaf (null/bool/int/real/date/uid)
    }
  }
}
