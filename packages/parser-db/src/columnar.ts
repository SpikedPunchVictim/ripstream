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
import { parquetMetadata, parquetReadObjects, parquetSchema } from "hyparquet";

/** Parquet reader plus ORC/Avro signature metadata. */
export class ColumnarParser implements Parser {
  readonly name = "ColumnarParser";
  readonly capabilities = { unsafe: true } as const;

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/vnd.apache.parquet",
        "application/x-parquet",
        "application/vnd.apache.orc",
        "application/avro",
        "application/x-avro",
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
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    if (ascii(data, 0, 4) === "PAR1") {
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const footer = parquetMetadata(buffer);
      const schema = parquetSchema(footer);
      const columns = schema.children.map((child) => child.element.name);
      metadata.set("parquet:row-count", String(footer.num_rows));
      metadata.add("parquet:column", columns.join(", "));
      await xhtml.element("h1", "Parquet");
      await xhtml.element("p", `Rows: ${footer.num_rows}`);
      const rows = await parquetReadObjects({
        file: buffer,
        rowStart: 0,
        rowEnd: 100,
      });
      for (const row of rows) {
        await xhtml.element("p", JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
      }
    } else if (ascii(data, 0, 4) === "Obj\u0001") {
      metadata.set("avro:format", "container");
      await xhtml.element("h1", "Avro container");
    } else if (ascii(data, 0, 3) === "ORC") {
      metadata.set("orc:format", "ORC");
      await xhtml.element("h1", "ORC");
    } else {
      throw new MalformedDocumentError("Unsupported columnar format");
    }
    await xhtml.endDocument();
  }
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}
