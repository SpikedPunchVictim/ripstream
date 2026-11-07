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
import {
  applyPropertySetMetadata,
  parsePropertySets,
} from "./property-sets.ts";

const WORD_DOCUMENT = "application/msword";
const WORD_DOCUMENT_ALT = "application/vnd.ms-word";

interface Piece {
  readonly cpStart: number;
  readonly cpEnd: number;
  readonly fileOffset: number;
  readonly compressed: boolean;
}

/** Word 6/95/97-2003 binary (.doc) text extraction. */
export class WordBinaryParser implements Parser {
  readonly name = "WordParser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [WORD_DOCUMENT, WORD_DOCUMENT_ALT].map((type) => MediaType.parse(type)!),
    );
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
      throw new MalformedDocumentError("Not a binary Word document");
    }
    const compound = CompoundFile.parse(data);
    if (isEncryptedCompound(compound)) {
      throw new EncryptedDocumentError("Word document is encrypted");
    }

    for (const name of ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"]) {
      if (!compound.has(name)) continue;
      try {
        applyPropertySetMetadata(
          metadata,
          parsePropertySets(compound.read(name)),
        );
      } catch {
        // Property sets are optional; malformed ones must not fail the parse.
      }
    }

    const wordDocument = compound.read("WordDocument");
    const text = extractText(wordDocument, compound);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const paragraph of text.split(/\n/)) {
      const value = paragraph.replace(/\r/g, "").trimEnd();
      if (value.length === 0) continue;
      await xhtml.startElement("p");
      await xhtml.characters(value);
      await xhtml.endElement("p");
    }
    await xhtml.endDocument();
  }
}

function extractText(
  wordDocument: Uint8Array,
  compound: CompoundFile,
): string {
  if (wordDocument.byteLength < 32 || readUInt16(wordDocument, 0) !== 0xa5ec) {
    throw new MalformedDocumentError("Invalid Word document FIB");
  }
  const flags = readUInt16(wordDocument, 10);
  if ((flags & 0x0100) !== 0) {
    throw new EncryptedDocumentError("Word document is encrypted");
  }

  const nFib = readUInt16(wordDocument, 2);
  if (nFib < 0x00c1) return extractWord95(wordDocument);

  const tableName = (flags & 0x0200) !== 0 ? "1Table" : "0Table";
  if (!compound.has(tableName)) {
    throw new MalformedDocumentError(`Missing Word table stream: ${tableName}`);
  }
  const table = compound.read(tableName);
  const fcClx = readUInt32(wordDocument, 0x01a2);
  const lcbClx = readUInt32(wordDocument, 0x01a6);
  if (lcbClx === 0 || fcClx + lcbClx > table.byteLength) {
    throw new MalformedDocumentError("Invalid Word piece table location");
  }

  const pieces = readPieceTable(table.subarray(fcClx, fcClx + lcbClx));
  let text = "";
  for (const piece of pieces) {
    text += readPiece(wordDocument, piece);
  }
  return cleanWordText(text);
}

function extractWord95(wordDocument: Uint8Array): string {
  const fcMin = readUInt32(wordDocument, 0x18);
  const fcMac = readUInt32(wordDocument, 0x1c);
  if (fcMin >= fcMac || fcMac > wordDocument.byteLength) {
    throw new MalformedDocumentError("Invalid Word 6/95 text range");
  }
  return cleanWordText(
    new TextDecoder("windows-1252").decode(
      wordDocument.subarray(fcMin, fcMac),
    ),
  );
}

function readPieceTable(clx: Uint8Array): Piece[] {
  let position = 0;
  let plc: Uint8Array | undefined;

  while (position < clx.byteLength) {
    const type = clx[position]!;
    if (type === 0x01) {
      if (position + 3 > clx.byteLength) break;
      const size = readUInt16(clx, position + 1);
      position += 3 + size;
    } else if (type === 0x02) {
      if (position + 5 > clx.byteLength) break;
      const size = readUInt32(clx, position + 1);
      const start = position + 5;
      plc = clx.subarray(start, Math.min(start + size, clx.byteLength));
      break;
    } else {
      break;
    }
  }

  if (plc === undefined || plc.byteLength < 4) {
    throw new MalformedDocumentError("Missing Word piece table");
  }
  const count = Math.floor((plc.byteLength - 4) / 12);
  if (count <= 0) return [];
  const cps = (count + 1) * 4;
  const pieces: Piece[] = [];
  for (let index = 0; index < count; index++) {
    const cpStart = readUInt32(plc, index * 4);
    const cpEnd = readUInt32(plc, (index + 1) * 4);
    const pcd = cps + index * 8;
    if (pcd + 8 > plc.byteLength) break;
    let fc = readUInt32(plc, pcd + 2);
    const compressed = (fc & 0x40000000) !== 0;
    fc &= 0x3fffffff;
    if (compressed) fc >>>= 1;
    pieces.push({ cpStart, cpEnd, fileOffset: fc, compressed });
  }
  return pieces;
}

function readPiece(wordDocument: Uint8Array, piece: Piece): string {
  const length = Math.max(0, piece.cpEnd - piece.cpStart);
  if (length === 0) return "";
  const bytes = piece.compressed ? length : length * 2;
  const end = Math.min(piece.fileOffset + bytes, wordDocument.byteLength);
  if (piece.fileOffset >= end) return "";
  const slice = wordDocument.subarray(piece.fileOffset, end);
  return piece.compressed
    ? new TextDecoder("windows-1252").decode(slice)
    : decodeUtf16(slice);
}

function decodeUtf16(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    result += String.fromCharCode(readUInt16(bytes, index));
  }
  return result;
}

/** Normalizes Word control characters into text-friendly output. */
export function cleanWordText(raw: string): string {
  let result = "";
  let fieldDepth = 0;
  let inInstruction = false;

  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code === 0x13) {
      fieldDepth++;
      inInstruction = true;
      continue;
    }
    if (code === 0x14) {
      inInstruction = false;
      continue;
    }
    if (code === 0x15) {
      fieldDepth = Math.max(0, fieldDepth - 1);
      inInstruction = false;
      continue;
    }
    if (fieldDepth > 0 && inInstruction) continue;

    if (code === 0x0d || code === 0x0b || code === 0x0c) result += "\n";
    else if (code === 0x07) result += "\t";
    else if (code === 0x1e) result += "-";
    else if (code === 0x1f || code === 0x05 || code === 0x08) continue;
    else if (code < 0x20 && code !== 0x09 && code !== 0x0a) continue;
    else result += char;
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
