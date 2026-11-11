import {
  MediaType,
  Metadata,
  RipstreamInputStream,
  XHTMLContentHandler,
  signalCheckpoint,
  type ContentHandler,
  type ParseContext,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { readAll } from "./bytes.ts";
import { formatCell } from "./sas-format.ts";
import { readSasFile, type SasColumn } from "./sas7bdat-file.ts";

/*
 * Port of Tika 4.2.0's SAS7BDATParser (tika-parser-code-module): a SAS dataset is a table under its name, with the file's
 * properties as metadata. Tika reads the file with parso, whose source was not available; the reading is sas7bdat-file.ts and
 * its limits are listed there. Read from the Tika source, not run against a Tika.
 */

const SAS_TYPE = "application/x-sas-data";
/** A row is cheap and a file can hold millions; the checkpoint keeps an abort from waiting for the last one. */
const ABORT_CHECK_INTERVAL = 256;
/** What a small compressed file may inflate to whatever its ratio, so that a few rows of blanks are not a bomb. */
const MIN_INFLATED_BYTES = 1024 * 1024;

export class Sas7bdatParser implements Parser {
  readonly name = "SAS7BDATParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parseOrThrow(SAS_TYPE)]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    metadata.set("Content-Type", SAS_TYPE);
    const data = await readAll(stream);
    // What the rows of a compressed file may inflate to: the ratio the limits allow of the file, and no more than they allow in all.
    const maxInflated = Math.min(ctx.limits.maxTotalEmbeddedBytes, data.length * ctx.limits.maxDecompressionRatio + MIN_INFLATED_BYTES);
    const sas = readSasFile(data, { maxInflatedBytes: maxInflated });
    const { properties, columns } = sas;

    metadata.set("dc:title", properties.name);
    setDate(metadata, "dcterms:created", properties.created);
    setDate(metadata, "dcterms:modified", properties.modified);
    metadata.set("xmpTPg:NPages", properties.pageCount);
    metadata.set("database:column-count", properties.columnCount);
    metadata.set("database:row-count", properties.rowCount);
    if (properties.encoding !== null) metadata.set("Content-Encoding", properties.encoding);
    metadata.set("extended-properties:Application", properties.serverType);
    metadata.set("extended-properties:AppVersion", properties.sasRelease);
    metadata.set("machine:architectureBits", String(properties.bits));
    metadata.set("machine:endian", properties.endian);
    for (const column of columns) metadata.add("database:column-name", heading(column));

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    await xhtml.element("h1", properties.name);
    await xhtml.startElement("table");
    await xhtml.newline();
    await xhtml.startElement("tr");
    for (const column of columns) {
      await xhtml.startElement("th", "title", column.name);
      await xhtml.characters(heading(column));
      await xhtml.endElement("th");
    }
    await xhtml.endElement("tr");
    await xhtml.newline();

    const tick = signalCheckpoint(ctx, ABORT_CHECK_INTERVAL);
    for (const row of sas.rows()) {
      tick();
      await xhtml.startElement("tr");
      for (const [index, column] of columns.entries()) {
        // An explicit start and end, not element(), so that an empty cell is still written.
        await xhtml.startElement("td");
        await xhtml.characters(formatCell(column, row[index] ?? null));
        await xhtml.endElement("td");
      }
      await xhtml.endElement("tr");
      await xhtml.newline();
    }
    await xhtml.endElement("table");
    await xhtml.endDocument();
  }
}

/** The label of a column, or its name where it has none. */
function heading(column: SasColumn): string {
  return column.label === "" ? column.name : column.label;
}

/** Tika's date format has no fraction of a second, and a date the header cannot hold is left out. */
function setDate(metadata: Metadata, key: string, date: Date | null): void {
  if (date !== null) metadata.set(key, `${date.toISOString().slice(0, 19)}Z`);
}
