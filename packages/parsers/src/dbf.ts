import {
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

interface Field {
  readonly name: string;
  readonly type: string;
  readonly length: number;
}

/** dBASE (.dbf) table text extraction. */
export class DbfParser implements Parser {
  readonly name = "DBFParser";
  readonly capabilities = { requiresRandomAccess: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/x-dbf")!]);
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
    if (data.length < 32) throw new MalformedDocumentError("Truncated DBF header");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const recordCount = view.getUint32(4, true);
    const headerLength = view.getUint16(8, true);
    const recordLength = view.getUint16(10, true);
    if (headerLength > data.length || recordLength < 1) {
      throw new MalformedDocumentError("Invalid DBF header lengths");
    }

    const fields: Field[] = [];
    let fieldOffset = 32;
    while (fieldOffset + 32 <= headerLength && data[fieldOffset] !== 0x0d) {
      let name = "";
      for (let index = 0; index < 11 && data[fieldOffset + index] !== 0; index++) {
        name += String.fromCharCode(data[fieldOffset + index]!);
      }
      // Zero-length fields add no bytes per record; keeping them would let a
      // tiny file multiply records by up to ~2000 empty cells.
      if (data[fieldOffset + 16] === 0) {
        fieldOffset += 32;
        continue;
      }
      fields.push({
        name,
        type: String.fromCharCode(data[fieldOffset + 11]!),
        length: data[fieldOffset + 16]!,
      });
      fieldOffset += 32;
    }
    if (fields.length === 0) throw new MalformedDocumentError("DBF has no fields");

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.startElement("table");
    await xhtml.startElement("tr");
    for (const field of fields) await xhtml.element("th", field.name);
    await xhtml.endElement("tr");

    const tick = signalCheckpoint(ctx, 256);
    let recordOffset = headerLength;
    for (let record = 0; record < recordCount; record++) {
      tick();
      if (recordOffset + recordLength > data.length) break;
      if (data[recordOffset] !== 0x2a) {
        await xhtml.startElement("tr");
        let position = recordOffset + 1;
        const recordEnd = recordOffset + recordLength;
        for (const field of fields) {
          if (position + field.length > recordEnd) break;
          const raw = data.subarray(position, position + field.length);
          const value = new TextDecoder("windows-1252").decode(raw).trim();
          await xhtml.element("td", value);
          position += field.length;
        }
        await xhtml.endElement("tr");
      }
      recordOffset += recordLength;
    }
    await xhtml.endElement("table");
    await xhtml.endDocument();
  }
}
