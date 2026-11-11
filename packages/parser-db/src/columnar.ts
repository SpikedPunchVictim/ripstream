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
import { checkParquetFooter, checkParquetPages, PARQUET_ROW_END, type ParquetLimits } from "./parquet-limits.ts";

/** hyparquet's column read is quadratic in the schema (1,000 columns 69 ms, 5,000 about 1 s, 10,000 about 4.3 s, measured). */
export const DEFAULT_MAX_PARQUET_SCHEMA_ELEMENTS = 5_000;
/** Real schemas nest a few levels; the schema is walked recursively by hyparquet. */
export const DEFAULT_MAX_PARQUET_SCHEMA_DEPTH = 100;
/** hyparquet keeps every row group of the footer in memory (70,000 of them about 125 MiB, measured). */
export const DEFAULT_MAX_PARQUET_ROW_GROUPS = 10_000;
/** hyparquet allocates and fills what a page's header claims, however few bytes the page has (2^26 values: 5.7 s and 484 MiB from a 123-byte file, measured). */
export const DEFAULT_MAX_PARQUET_PAGE_VALUES = 4_194_304;

export interface ColumnarParserOptions {
  /** Maximum schema elements (columns and groups, and the root) a Parquet footer may list (default {@link DEFAULT_MAX_PARQUET_SCHEMA_ELEMENTS}). */
  readonly maxSchemaElements?: number;
  /** Maximum nesting of the Parquet schema, the root being level 1 (default {@link DEFAULT_MAX_PARQUET_SCHEMA_DEPTH}). */
  readonly maxSchemaDepth?: number;
  /** Maximum row groups a Parquet footer may list (default {@link DEFAULT_MAX_PARQUET_ROW_GROUPS}). */
  readonly maxRowGroups?: number;
  /** Maximum values one Parquet page header may claim (default {@link DEFAULT_MAX_PARQUET_PAGE_VALUES}). */
  readonly maxPageValues?: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

/** Parquet reader plus ORC/Avro signature metadata. */
export class ColumnarParser implements Parser {
  readonly name = "ColumnarParser";
  readonly capabilities = { unsafe: true } as const;
  readonly #limits: ParquetLimits;

  constructor(options: ColumnarParserOptions = {}) {
    this.#limits = {
      maxSchemaElements: positiveInteger("maxSchemaElements", options.maxSchemaElements ?? DEFAULT_MAX_PARQUET_SCHEMA_ELEMENTS),
      maxSchemaDepth: positiveInteger("maxSchemaDepth", options.maxSchemaDepth ?? DEFAULT_MAX_PARQUET_SCHEMA_DEPTH),
      maxRowGroups: positiveInteger("maxRowGroups", options.maxRowGroups ?? DEFAULT_MAX_PARQUET_ROW_GROUPS),
      maxPageValues: positiveInteger("maxPageValues", options.maxPageValues ?? DEFAULT_MAX_PARQUET_PAGE_VALUES),
    };
  }

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
      // hyparquet has no limits of its own: nothing below runs on a footer or page header that claims too much.
      checkParquetFooter(footer, this.#limits);
      checkParquetPages(buffer, footer, this.#limits);
      const schema = parquetSchema(footer);
      const columns = schema.children.map((child) => child.element.name);
      metadata.set("parquet:row-count", String(footer.num_rows));
      metadata.add("parquet:column", columns.join(", "));
      await xhtml.element("h1", "Parquet");
      await xhtml.element("p", `Rows: ${footer.num_rows}`);
      const rows = await parquetReadObjects({
        file: buffer,
        rowStart: 0,
        rowEnd: PARQUET_ROW_END,
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
