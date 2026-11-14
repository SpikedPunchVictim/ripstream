import { LimitExceededError, MalformedDocumentError } from "@spikedpunch/ripstream-core";
import type { ColumnChunk, FileMetaData, RowGroup, SchemaElement } from "hyparquet";
// hyparquet has no limits of its own and does not export its page header reader, so this is the one internal module
// used: the pinned 1.17.1 compact-thrift decoder that its own column reader calls.
import { deserializeTCompactProtocol } from "hyparquet/src/thrift.js";

/** What hyparquet is allowed to be asked to do for one file. */
export interface ParquetLimits {
  readonly maxSchemaElements: number;
  readonly maxSchemaDepth: number;
  readonly maxRowGroups: number;
  readonly maxPageValues: number;
  /** Most bytes the thrift footer may take; it is decoded whole, into about 200 times its size. */
  readonly maxFooterBytes: number;
  /** Most values all the page headers of the row groups that are read may claim between them. */
  readonly maxTotalValues: number;
}

/** The rows the parser asks hyparquet for: row 0 up to, not including, this one. */
export const PARQUET_ROW_END = 100;

/** hyparquet skips a column chunk larger than this and reads nothing of it. */
const MAX_COLUMN_CHUNK_BYTES = 1 << 30;

/**
 * Checks the trailer (footer length, then "PAR1") before hyparquet decodes the footer: that decode allocates about
 * 200 times the footer's bytes (4 MB gave 883 MB, 48 MB ran out of heap), whatever the file's other limits say.
 * Throws LimitExceededError or MalformedDocumentError.
 */
export function checkParquetTrailer(file: Uint8Array, limits: ParquetLimits): void {
  const length = file.byteLength;
  const magic = String.fromCharCode(...file.subarray(Math.max(0, length - 4)));
  if (length < 12 || magic !== "PAR1") throw new MalformedDocumentError("Parquet file has no footer");
  const footerLength = new DataView(file.buffer, file.byteOffset, length).getUint32(length - 8, true);
  if (footerLength + 12 > length) throw new MalformedDocumentError("Parquet footer is longer than the file");
  if (footerLength > limits.maxFooterBytes) {
    throw new LimitExceededError(`Parquet footer is ${footerLength} bytes, more than the limit of ${limits.maxFooterBytes}`);
  }
}

/**
 * Checks of the footer that are cheap and need nothing decoded: how many schema elements and row groups it lists, how
 * deep the schema nests, and that the schema is a well-formed tree. Throws LimitExceededError or MalformedDocumentError.
 */
export function checkParquetFooter(footer: FileMetaData, limits: ParquetLimits): void {
  if (footer.schema.length > limits.maxSchemaElements) {
    throw new LimitExceededError(
      `Parquet footer lists ${footer.schema.length} schema elements, more than the limit of ${limits.maxSchemaElements}`,
    );
  }
  if (footer.row_groups.length > limits.maxRowGroups) {
    throw new LimitExceededError(
      `Parquet footer lists ${footer.row_groups.length} row groups, more than the limit of ${limits.maxRowGroups}`,
    );
  }
  const depth = schemaDepth(footer.schema);
  if (depth > limits.maxSchemaDepth) {
    throw new LimitExceededError(`Parquet schema is nested deeper than ${limits.maxSchemaDepth} levels`);
  }
}

/**
 * The deepest level of the schema, the root being level 1. The schema is a pre-order list in which each group says how
 * many children follow it; the walk keeps one counter per open group instead of recursing, so a hostile depth costs
 * memory in proportion to the list, not stack.
 */
function schemaDepth(schema: readonly SchemaElement[]): number {
  if (schema.length === 0) throw new MalformedDocumentError("Parquet footer has no schema");
  const childrenLeft: number[] = [];
  let deepest = 0;
  for (const [index, element] of schema.entries()) {
    if (index > 0 && childrenLeft.length === 0) {
      throw new MalformedDocumentError("Parquet schema lists elements outside the root");
    }
    deepest = Math.max(deepest, childrenLeft.length + 1);
    if (childrenLeft.length > 0) childrenLeft[childrenLeft.length - 1]!--;
    const children = element.num_children ?? 0;
    if (children > 0) childrenLeft.push(children);
    while (childrenLeft.length > 0 && childrenLeft[childrenLeft.length - 1] === 0) childrenLeft.pop();
  }
  if (childrenLeft.length > 0) {
    throw new MalformedDocumentError("Parquet schema ends before the children its groups declare");
  }
  return deepest;
}

/**
 * Walks the page headers of every column chunk in the row groups that will be read, which is the same bytes hyparquet
 * will decode, and refuses a page that claims more values than the limit or than its chunk. Each header is a few bytes,
 * so this costs a fraction of the read it guards. Throws LimitExceededError or MalformedDocumentError.
 */
export function checkParquetPages(
  file: ArrayBuffer,
  footer: FileMetaData,
  limits: ParquetLimits,
  checkpoint: () => void = () => {},
): void {
  const claimed = { values: 0 };
  let groupStart = 0;
  for (const group of footer.row_groups) {
    if (groupStart >= PARQUET_ROW_END) break;
    checkRowGroup(file, group, limits, claimed, checkpoint);
    groupStart += Number(group.num_rows);
  }
}

function checkRowGroup(
  file: ArrayBuffer,
  group: RowGroup,
  limits: ParquetLimits,
  claimed: { values: number },
  checkpoint: () => void,
): void {
  for (const chunk of group.columns) {
    checkpoint();
    const meta = chunk.meta_data;
    if (meta === undefined) continue; // hyparquet reports the missing metadata itself
    const offset = meta.dictionary_page_offset || meta.data_page_offset;
    const start = Number(offset);
    const end = Number(offset + meta.total_compressed_size);
    if (!(start >= 0 && end >= start)) {
      throw new MalformedDocumentError(`Parquet column ${meta.path_in_schema.join(".")} has an invalid byte range`);
    }
    if (end - start > MAX_COLUMN_CHUNK_BYTES) continue;
    checkChunkPages(file, chunk, start, end, limits, claimed);
  }
}

function checkChunkPages(
  file: ArrayBuffer,
  chunk: ColumnChunk,
  start: number,
  end: number,
  limits: ParquetLimits,
  claimed: { values: number },
): void {
  const name = chunk.meta_data!.path_in_schema.join(".");
  const chunkValues = Number(chunk.meta_data!.num_values);
  // The window hyparquet slices for the chunk: it ends at the end of the file if the footer says it ends later.
  const first = Math.min(start, file.byteLength);
  const last = Math.min(end, file.byteLength);
  const view = new DataView(file, first, last - first);
  const reader = { view, offset: 0 };
  while (reader.offset < view.byteLength - 1) {
    const header = readPageHeader(reader, name);
    checkPage(header, chunkValues, name, limits);
    // Each page is within the limit, but thousands of them are not: the reader fills every value a header claims.
    claimed.values += header.values ?? 0;
    if (claimed.values > limits.maxTotalValues) {
      throw new LimitExceededError(`Parquet page headers claim more than the limit of ${limits.maxTotalValues} values between them`);
    }
    if (reader.offset + header.compressedSize > view.byteLength) {
      throw new MalformedDocumentError(`Parquet page in column ${name} extends past its column chunk`);
    }
    reader.offset += header.compressedSize;
  }
}

interface PageSummary {
  readonly type: number;
  readonly compressedSize: number;
  readonly values: number | undefined;
}

const DATA_PAGE = 0;
const DICTIONARY_PAGE = 2;
const DATA_PAGE_V2 = 3;

/** The page header's thrift fields: 1 type, 3 compressed size, and the value count inside field 5, 7 or 8. */
function readPageHeader(reader: { view: DataView; offset: number }, column: string): PageSummary {
  let header: ReturnType<typeof deserializeTCompactProtocol>;
  try {
    header = deserializeTCompactProtocol(reader);
  } catch (error) {
    throw new MalformedDocumentError(`Invalid Parquet page header in column ${column}`, { cause: error });
  }
  const type = header.field_1 as number;
  const compressedSize = header.field_3 as number;
  if (!Number.isSafeInteger(compressedSize) || compressedSize < 0) {
    throw new MalformedDocumentError(`Parquet page in column ${column} has an invalid size`);
  }
  const body = type === DATA_PAGE ? header.field_5 : type === DICTIONARY_PAGE ? header.field_7 : type === DATA_PAGE_V2 ? header.field_8 : undefined;
  return { type, compressedSize, values: body?.field_1 as number | undefined };
}

function checkPage(page: PageSummary, chunkValues: number, column: string, limits: ParquetLimits): void {
  if (page.values === undefined) return;
  if (page.values > limits.maxPageValues) {
    throw new LimitExceededError(
      `Parquet page in column ${column} claims ${page.values} values, more than the limit of ${limits.maxPageValues}`,
    );
  }
  // A dictionary may list entries the chunk's own values never use; a data page may not outgrow the chunk.
  if (page.type !== DICTIONARY_PAGE && page.values > chunkValues) {
    throw new MalformedDocumentError(
      `Parquet page in column ${column} claims ${page.values} values, its column chunk ${chunkValues}`,
    );
  }
}
