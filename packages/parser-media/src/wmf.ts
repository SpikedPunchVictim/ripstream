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

/** WMF/EMF header metadata (bounds and version). */
export class WmfEmfParser implements Parser {
  readonly name = "WMFParser";
  readonly capabilities = { metadataOnly: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["image/wmf", "image/emf", "application/vnd.semf"].map(
        (type) => MediaType.parse(type)!,
      ),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    _handler: ContentHandler,
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
    if (data.length < 8) throw new MalformedDocumentError("Truncated metafile");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length >= 48 && view.getUint32(0, true) === 1 && data[40] === 0x20) {
      metadata.set("emf:version", String(view.getUint32(44, true)));
      setBounds(
        metadata,
        view.getInt32(8, true),
        view.getInt32(12, true),
        view.getInt32(16, true),
        view.getInt32(20, true),
      );
      if (_handler !== undefined) await emitText(_handler, metadata, emfText(data, view));
      return;
    }
    if (data.length >= 22 && view.getUint32(0, true) === 0x9ac6cdd7) {
      setBounds(
        metadata,
        view.getInt16(6, true),
        view.getInt16(8, true),
        view.getInt16(10, true),
        view.getInt16(12, true),
      );
      if (_handler !== undefined) await emitText(_handler, metadata, wmfText(data, view, 40));
      return;
    }
    // Standard (non-placeable) WMF: METAHEADER with no bounds. Type 1 = memory,
    // 2 = disk; HeaderSize is 9 words; Version is 0x0100 or 0x0300.
    if (
      data.length >= 18 &&
      (view.getUint16(0, true) === 1 || view.getUint16(0, true) === 2) &&
      view.getUint16(2, true) === 9 &&
      (view.getUint16(4, true) === 0x0100 || view.getUint16(4, true) === 0x0300)
    ) {
      if (_handler !== undefined) await emitText(_handler, metadata, wmfText(data, view, 18));
      return;
    }
    throw new MalformedDocumentError("Not a WMF/EMF file");
  }
}

const EMR_EXTTEXTOUTA = 83;
const EMR_EXTTEXTOUTW = 84;
const WMF_EXTTEXTOUT = 0x0a32;
const WMF_TEXTOUT = 0x0521;

/** Text strings of an EMF: EMR_EXTTEXTOUTA/W records, whose EmrText names its string by record offset. */
function emfText(data: Uint8Array, view: DataView): string[] {
  const texts: string[] = [];
  let position = 0;
  while (position + 8 <= data.length) {
    const type = view.getUint32(position, true);
    const size = view.getUint32(position + 4, true);
    if (size < 8 || position + size > data.length) break;
    if (type === EMR_EXTTEXTOUTA || type === EMR_EXTTEXTOUTW) {
      const chars = view.getInt32(position + 44, true);
      const stringOffset = view.getUint32(position + 48, true);
      const start = position + stringOffset;
      const bytes = type === EMR_EXTTEXTOUTW ? chars * 2 : chars;
      if (chars > 0 && start >= position + 8 && start + bytes <= position + size) {
        const decoder = type === EMR_EXTTEXTOUTW ? new TextDecoder("utf-16le") : new TextDecoder("windows-1252");
        texts.push(decoder.decode(data.subarray(start, start + bytes)));
      }
    }
    position += size;
  }
  return texts;
}

/** Text strings of a WMF: META_EXTTEXTOUT and META_TEXTOUT records, from the record area after the header. */
function wmfText(data: Uint8Array, view: DataView, start: number): string[] {
  const texts: string[] = [];
  let position = start;
  while (position + 6 <= data.length) {
    const sizeWords = view.getUint32(position, true);
    const size = sizeWords * 2;
    if (size < 6 || position + size > data.length) break;
    const fn = view.getUint16(position + 4, true);
    if (fn === WMF_TEXTOUT) {
      const count = view.getInt16(position + 6, true);
      const textStart = position + 8;
      if (count > 0 && textStart + count <= position + size) texts.push(decodeWmfString(data.subarray(textStart, textStart + count)));
    } else if (fn === WMF_EXTTEXTOUT) {
      const count = view.getInt16(position + 6 + 4, true);
      const textStart = position + 6 + 8;
      if (count > 0 && textStart + count <= position + size) texts.push(decodeWmfString(data.subarray(textStart, textStart + count)));
    }
    position += size;
  }
  return texts;
}

/** WMF strings are in the font's code page: Shift_JIS when the bytes carry its double-byte leads, else cp1252. */
function decodeWmfString(bytes: Uint8Array): string {
  const doubleByte = bytes.some((byte) => (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xef));
  try {
    return new TextDecoder(doubleByte ? "shift_jis" : "windows-1252").decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

async function emitText(handler: ContentHandler, metadata: Metadata, texts: readonly string[]): Promise<void> {
  if (texts.length === 0) return;
  const xhtml = new XHTMLContentHandler(handler, metadata);
  await xhtml.startDocument();
  for (const text of texts) {
    const value = text.replace(/\u0000/g, "").trim();
    if (value.length >= 4) await xhtml.element("p", value);
  }
  await xhtml.endDocument();
}

function setBounds(
  metadata: Metadata,
  left: number,
  top: number,
  right: number,
  bottom: number,
): void {
  metadata.set("tiff:ImageWidth", String(Math.abs(right - left)));
  metadata.set("tiff:ImageLength", String(Math.abs(bottom - top)));
}
