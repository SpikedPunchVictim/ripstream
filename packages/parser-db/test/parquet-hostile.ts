import type { ColumnChunk, ColumnMetaData, RowGroup, SchemaElement } from "hyparquet";
import { ByteWriter, ParquetWriter } from "hyparquet-writer";
import { writePageHeader } from "hyparquet-writer/src/datapage.js";

/**
 * Parquet files whose footer or page headers claim far more than their bytes hold. hyparquet-writer only writes honest
 * files, so these are put together from its own pieces: the footer is serialized from whatever metadata is passed in.
 */

export function leaf(name: string): SchemaElement {
  return { name, type: "INT32", repetition_type: "REQUIRED" };
}

export function chunkOf(name: string, numValues = 1n, dataPageOffset = 4n): ColumnChunk {
  const meta_data: ColumnMetaData = {
    type: "INT32",
    encodings: ["PLAIN"],
    path_in_schema: [name],
    codec: "UNCOMPRESSED",
    num_values: numValues,
    total_uncompressed_size: 0n,
    total_compressed_size: 0n,
    data_page_offset: dataPageOffset,
  };
  return { file_offset: dataPageOffset, meta_data };
}

/**
 * PAR1, whatever `writePages` appends (it returns the row groups that describe those bytes), then a footer made from
 * `schema` and those row groups.
 */
export function parquetWith(
  schema: SchemaElement[],
  rowGroups: RowGroup[] | ((writer: ByteWriter) => RowGroup[]),
): Uint8Array {
  const writer = new ByteWriter();
  // ParquetWriter writes the PAR1 header on construction and the footer in finish().
  const parquet = new ParquetWriter({ writer, schema });
  const groups = typeof rowGroups === "function" ? rowGroups(writer) : rowGroups;
  parquet.row_groups = groups;
  parquet.num_rows = groups.reduce((sum, group) => sum + group.num_rows, 0n);
  parquet.finish();
  return new Uint8Array(writer.getBuffer());
}

/** A footer with `columns` INT32 leaves under the root and no row groups. */
export function wideSchemaFooter(columns: number): Uint8Array {
  const schema: SchemaElement[] = [{ name: "root", num_children: columns }];
  for (let i = 0; i < columns; i++) schema.push(leaf(`c${i}`));
  return parquetWith(schema, []);
}

/** A footer whose schema is a chain of `depth` groups ending in one leaf. */
export function deepSchemaFooter(depth: number): Uint8Array {
  const schema: SchemaElement[] = [{ name: "root", num_children: 1 }];
  for (let i = 0; i < depth; i++) schema.push({ name: `g${i}`, num_children: 1, repetition_type: "REQUIRED" });
  schema.push(leaf("leaf"));
  return parquetWith(schema, []);
}

/** A footer with `count` one-row row groups over one column, none of them backed by data. */
export function manyRowGroupsFooter(count: number): Uint8Array {
  const schema: SchemaElement[] = [{ name: "root", num_children: 1 }, leaf("a")];
  const groups: RowGroup[] = [];
  for (let i = 0; i < count; i++) groups.push({ columns: [chunkOf("a")], total_byte_size: 0n, num_rows: 1n });
  return parquetWith(schema, groups);
}

/** A schema whose root claims two children and has one. */
export function truncatedSchemaFooter(): Uint8Array {
  return parquetWith([{ name: "root", num_children: 2 }, leaf("a")], []);
}

export interface PageBombOptions {
  /** num_values the data page header claims. */
  readonly pageValues: number;
  /** num_values the column chunk in the footer claims (default: the same as the page). */
  readonly chunkValues?: number;
}

/** Unsigned LEB128, as the RLE/bit-packed hybrid writes a run header. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

/**
 * One INT32 column whose only data page is three bytes of body: bit width 1 and one RLE run of `pageValues` zeroes. The
 * reader allocates and fills `pageValues` entries from them. The footer is honest about the byte layout.
 */
export function pageBomb(options: PageBombOptions): Uint8Array {
  const chunkValues = options.chunkValues ?? options.pageValues;
  const schema: SchemaElement[] = [{ name: "root", num_children: 1 }, leaf("a")];
  return parquetWith(schema, (writer) => {
    const start = writer.offset;
    const body = [1, ...varint(options.pageValues * 2), 0];
    writePageHeader(writer, {
      type: "DATA_PAGE_V2",
      uncompressed_page_size: body.length,
      compressed_page_size: body.length,
      data_page_header_v2: {
        num_values: options.pageValues,
        num_nulls: 0,
        num_rows: options.pageValues,
        encoding: "RLE_DICTIONARY",
        definition_levels_byte_length: 0,
        repetition_levels_byte_length: 0,
        is_compressed: false,
      },
    });
    for (const byte of body) writer.appendUint8(byte);
    const chunk = chunkOf("a", BigInt(chunkValues), BigInt(start));
    chunk.meta_data!.total_compressed_size = BigInt(writer.offset - start);
    return [{ columns: [chunk], total_byte_size: BigInt(writer.offset - start), num_rows: BigInt(chunkValues) }];
  });
}

export type PageKind = "data" | "data-v2" | "dictionary";

export interface PageSpec {
  readonly kind: PageKind;
  /** num_values the page header claims. */
  readonly values: number;
  /** Bytes of body that follow the header (default 0). */
  readonly body?: number;
  /** compressed_page_size the header claims (default: the body length). */
  readonly claimedSize?: number;
}

function writeHeader(writer: ByteWriter, page: PageSpec): void {
  const size = page.claimedSize ?? page.body ?? 0;
  const base = { uncompressed_page_size: size, compressed_page_size: size };
  if (page.kind === "data") {
    writePageHeader(writer, {
      type: "DATA_PAGE",
      ...base,
      data_page_header: {
        num_values: page.values,
        encoding: "PLAIN",
        definition_level_encoding: "RLE",
        repetition_level_encoding: "RLE",
      },
    });
  } else if (page.kind === "dictionary") {
    writePageHeader(writer, {
      type: "DICTIONARY_PAGE",
      ...base,
      dictionary_page_header: { num_values: page.values, encoding: "PLAIN" },
    });
  } else {
    writePageHeader(writer, {
      type: "DATA_PAGE_V2",
      ...base,
      data_page_header_v2: {
        num_values: page.values,
        num_nulls: 0,
        num_rows: page.values,
        encoding: "PLAIN",
        definition_levels_byte_length: 0,
        repetition_levels_byte_length: 0,
        is_compressed: false,
      },
    });
  }
}

/**
 * A file that is PAR1 and then `pages` (header and body each) and then `trailing` raw bytes: the bytes of one column
 * chunk that starts at offset 4. `chunkSize` is the length of the pages and trailing bytes.
 */
export function pagesFile(pages: readonly PageSpec[], trailing: readonly number[] = []): { file: ArrayBuffer; chunkSize: number } {
  const writer = new ByteWriter();
  for (const byte of [0x50, 0x41, 0x52, 0x31]) writer.appendUint8(byte);
  for (const page of pages) {
    writeHeader(writer, page);
    for (let i = 0; i < (page.body ?? 0); i++) writer.appendUint8(0);
  }
  for (const byte of trailing) writer.appendUint8(byte);
  return { file: writer.getBuffer(), chunkSize: writer.offset - 4 };
}

export interface ChunkOptions {
  readonly numValues?: bigint;
  readonly dataPageOffset?: bigint;
  readonly dictionaryPageOffset?: bigint;
}

/** A column chunk whose footer entry says it is `size` bytes at `dataPageOffset` (default 4). */
export function chunkSized(size: number | bigint, options: ChunkOptions = {}): ColumnChunk {
  const chunk = chunkOf("a", options.numValues ?? 1_000_000n, options.dataPageOffset ?? 4n);
  chunk.meta_data!.total_compressed_size = BigInt(size);
  if (options.dictionaryPageOffset !== undefined) chunk.meta_data!.dictionary_page_offset = options.dictionaryPageOffset;
  return chunk;
}

/** A row group of `rows` rows over `chunks`, for tests that call checkParquetPages directly. */
export function rowGroupOf(rows: number, ...chunks: ColumnChunk[]): RowGroup {
  return { columns: chunks, total_byte_size: 0n, num_rows: BigInt(rows) };
}
