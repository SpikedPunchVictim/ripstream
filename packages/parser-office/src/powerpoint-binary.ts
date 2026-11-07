import {
  EncryptedDocumentError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { CompoundFile, hasSignature, isEncryptedCompound } from "./cfb.ts";
import { applyPropertySetMetadata, parsePropertySets } from "./property-sets.ts";

const POWERPOINT = "application/vnd.ms-powerpoint";
const TEXT_CHARS_ATOM = 0x0fa0;
const TEXT_BYTES_ATOM = 0x0fa8;
const CSTRING_ATOM = 0x0fba;
const CONTAINER_VERSION = 0x000f;
const MAX_CONTAINER_DEPTH = 64;

/** PowerPoint 97-2003 binary (.ppt) text extraction from text atoms. */
export class PowerPointBinaryParser implements Parser {
  readonly name = "PowerPointParser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse(POWERPOINT)!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
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

    if (!hasSignature(data)) {
      throw new MalformedDocumentError("Not a binary PowerPoint document");
    }
    const compound = CompoundFile.parse(data);
    if (isEncryptedCompound(compound)) {
      throw new EncryptedDocumentError("PowerPoint document is encrypted");
    }
    if (!compound.has("PowerPoint Document")) {
      throw new MalformedDocumentError("Missing PowerPoint Document stream");
    }

    for (const name of ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"]) {
      if (!compound.has(name)) continue;
      try {
        applyPropertySetMetadata(metadata, parsePropertySets(compound.read(name)));
      } catch {
        // Property sets are optional.
      }
    }

    const text = extractText(compound.read("PowerPoint Document"));
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const paragraph of text.split("\n")) {
      const value = paragraph.trim();
      if (value.length === 0) continue;
      await xhtml.startElement("p");
      await xhtml.characters(value);
      await xhtml.endElement("p");
    }
    await xhtml.endDocument();
  }
}

function extractText(stream: Uint8Array): string {
  let text = "";
  walk(stream, 0, stream.byteLength, 0, (value) => {
    text += value;
  });
  return text
    .replace(/[\u000b\u000c]/g, "\r")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000e-\u001f]/g, "");
}

function walk(
  data: Uint8Array,
  start: number,
  end: number,
  depth: number,
  emit: (text: string) => void,
): void {
  if (depth > MAX_CONTAINER_DEPTH) {
    throw new MalformedDocumentError(
      `PowerPoint container nesting exceeds ${MAX_CONTAINER_DEPTH} levels`,
    );
  }
  let position = start;
  while (position + 8 <= end) {
    const versionInstance = readUInt16(data, position);
    const type = readUInt16(data, position + 2);
    const length = readUInt32(data, position + 4);
    if (length > end - position - 8) break;
    const payload = data.subarray(position + 8, position + 8 + length);

    if (type === TEXT_CHARS_ATOM) {
      emit(decodeUtf16(payload));
    } else if (type === TEXT_BYTES_ATOM) {
      emit(new TextDecoder("windows-1252").decode(payload));
    } else if (type === CSTRING_ATOM) {
      const zero = payload.indexOf(0);
      emit(
        new TextDecoder("windows-1252").decode(
          zero === -1 ? payload : payload.subarray(0, zero),
        ),
      );
    } else if ((versionInstance & 0x000f) === CONTAINER_VERSION) {
      walk(payload, 0, payload.byteLength, depth + 1, emit);
    }

    position += 8 + length;
  }
}

function decodeUtf16(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    result += String.fromCharCode(readUInt16(bytes, index));
  }
  return result;
}

function readUInt16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readUInt32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    ((data[offset + 3] ?? 0) << 24)
  ) >>> 0;
}
