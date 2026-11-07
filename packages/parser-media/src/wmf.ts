import {
  MalformedDocumentError,
  MediaType,
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
      return;
    }
    throw new MalformedDocumentError("Not a WMF/EMF file");
  }
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
