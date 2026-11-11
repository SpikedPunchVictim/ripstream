import { MalformedDocumentError, RipstreamError, type Metadata } from "@spikedpunch/ripstream-core";
import {
  applyPropertySetMetadata,
  CompoundFile,
  hasSignature,
  parsePropertySets,
} from "@spikedpunch/ripstream-parser-office";

/** The two property set streams SummaryExtractor reads, in the order it reads them. */
const SUMMARY_STREAMS = ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"];

/**
 * A compound file (OLE2) of which streams are read with a bound. CompoundFile.read allocates a mini stream by the size
 * its directory entry declares, and the cutoff that picks the mini path comes from the header too, so a hostile entry
 * could ask for gigabytes. No stream of a compound file is longer than the file, which is the bound used here.
 */
export class OleFile {
  readonly #compound: CompoundFile;
  readonly #length: number;

  private constructor(compound: CompoundFile, length: number) {
    this.#compound = compound;
    this.#length = length;
  }

  static open(data: Uint8Array): OleFile {
    if (!hasSignature(data)) throw new MalformedDocumentError("Not a compound file");
    try {
      return new OleFile(CompoundFile.parse(data), data.length);
    } catch (error) {
      if (error instanceof RipstreamError) throw error;
      throw new MalformedDocumentError("Invalid compound file", { cause: error });
    }
  }

  has(path: string): boolean {
    return this.#compound.get(path)?.type === "stream";
  }

  /** The stream, or undefined when there is none of that name. */
  read(path: string): Uint8Array | undefined {
    const entry = this.#compound.get(path);
    if (entry === undefined || entry.type !== "stream") return undefined;
    if (entry.size > this.#length) {
      throw new MalformedDocumentError(`Compound file stream ${JSON.stringify(path)} declares ${entry.size} bytes`);
    }
    return this.#compound.read(path);
  }

  /**
   * SummaryExtractor.parseSummaries: SummaryInformation and DocumentSummaryInformation into metadata. A property set
   * that does not parse is skipped, as Tika skips one that is not a property set.
   */
  applySummaries(metadata: Metadata): void {
    for (const name of SUMMARY_STREAMS) {
      const stream = this.read(name);
      if (stream === undefined) continue;
      try {
        applyPropertySetMetadata(metadata, parsePropertySets(stream));
      } catch (error) {
        if (!(error instanceof MalformedDocumentError)) throw error;
      }
    }
  }
}
