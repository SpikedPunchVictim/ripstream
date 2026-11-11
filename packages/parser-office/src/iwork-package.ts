import {
  CONTEXT_KEYS,
  MalformedDocumentError,
  Metadata,
  ParsingEmbeddedDocumentExtractor,
  RipstreamInputStream,
  TIKA_KEYS,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type XHTMLContentHandler,
} from "@spikedpunch/ripstream-core";
import { boundedUnzip, type BoundedZip } from "./bounded-unzip.ts";
import { readAll } from "./bytes.ts";
import { describeFailure, isFatal } from "./failures.ts";

/*
 * How the iWork package parsers open a package and hand an entry to the embedded-document extractor. Tika calls
 * `parseEmbedded(stream, xhtml, metadata, context, true)`; the true is outputHtml, which wraps the entry in
 * <div class="package-entry"> with an <h1> of its resource name. That wrapper is the only text the thumbnail of an iWork
 * package gives, so it is written here. Read from Tika 4.2.0's IWork13PackageParser and IWork18PackageParser.
 */

/**
 * Indexes the package's ZIP entries without inflating any. Tika opens the package as a ZipFile, which refuses data that is
 * not a ZIP archive; the streaming reader here would read it as an archive with no entries, so that is refused first.
 */
export async function openPackage(stream: RipstreamInputStream, ctx: ParseContext): Promise<BoundedZip> {
  const data = await readAll(stream);
  const files = boundedUnzip(data, ctx.limits);
  if (files.names.length === 0 && !startsWith(data, EMPTY_ARCHIVE)) {
    throw new MalformedDocumentError("The data is not a ZIP package");
  }
  return files;
}

/** The end-of-central-directory record, which is all an archive of no entries holds. Data without entries and without it is not a ZIP. */
const EMPTY_ARCHIVE = [0x50, 0x4b, 0x05, 0x06];

function startsWith(data: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => data[index] === byte);
}

/** A metadata object for one entry, carrying its resource name, and its embedded resource type when it has one. */
export function entryMetadata(name: string, resourceType?: string): Metadata {
  const metadata = new Metadata();
  if (resourceType !== undefined) metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE, resourceType);
  metadata.set(TIKA_KEYS.RESOURCE_NAME, name);
  return metadata;
}

/**
 * Emits one package entry. A failure of the embedded document is recorded on the package's metadata and the parse goes on
 * (ParsingEmbeddedDocumentExtractor does the same for a TikaException); a limit, an abort or a timeout ends the parse.
 */
export async function emitPackageEntry(
  xhtml: XHTMLContentHandler,
  bytes: Uint8Array,
  embedded: Metadata,
  packageMetadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
    new ParsingEmbeddedDocumentExtractor();
  if (!extractor.shouldParseEmbedded(embedded)) return;
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    await xhtml.startElement("div", "class", "package-entry");
    await xhtml.element("h1", embedded.get(TIKA_KEYS.RESOURCE_NAME) ?? "");
    try {
      await extractor.parseEmbedded(stream, xhtml, embedded, ctx);
    } catch (error) {
      if (isFatal(error, ctx)) throw error;
      // EmbeddedDocumentUtil.recordEmbeddedStreamException: the exception's name and message, not a stack trace.
      packageMetadata.add(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION, describeFailure(error));
    }
    await xhtml.endElement("div");
  } finally {
    await stream.close();
  }
}
