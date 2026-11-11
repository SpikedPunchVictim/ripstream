import {
  MalformedDocumentError,
  MediaType,
  TIKA_KEYS,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import type { BoundedZip } from "./bounded-unzip.ts";
import { isFatal } from "./failures.ts";
import { emitPackageEntry, entryMetadata, openPackage } from "./iwork-package.ts";
import { parsePlist, plistText } from "./plist.ts";

/*
 * Port of Tika 4.2.0's IWork13PackageParser: the iWork '13 layout (a ZIP of Index/*.iwa parts, Metadata/ plists and
 * previews). The .iwa parts are Snappy-compressed protobuf that Tika does not decode, so this gives no text of the
 * document: metadata from three Metadata/ entries, the preview as a thumbnail, and every other entry as an embedded
 * document. Read from that source and its IWork13ParserTest; not run against a Tika.
 */

const PROPERTIES = "Metadata/Properties.plist";
const BUILD_VERSION_HISTORY = "Metadata/BuildVersionHistory.plist";
const DOCUMENT_IDENTIFIER = "Metadata/DocumentIdentifier";
const PREVIEW = "preview.jpg";
const SKIPPED_PREVIEWS = new Set(["preview-micro.jpg", "preview-web.jpg"]);
const IWORKS_PREFIX = "iwork:";
const DOCUMENT_ID_BYTES = 36;

const KEYNOTE = "application/vnd.apple.keynote.13";
const NUMBERS = "application/vnd.apple.numbers.13";
const PAGES = "application/vnd.apple.pages.13";
const UNKNOWN = "application/vnd.apple.unknown.13";

export class IWork13Parser implements Parser {
  readonly name = "IWork13PackageParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([KEYNOTE, NUMBERS, PAGES, UNKNOWN].map((type) => MediaType.parseOrThrow(type)));
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    const files = await openPackage(stream, ctx);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();

    // Tika goes on after an entry fails and reports the last failure once every entry has been tried.
    let failure: unknown;
    for (const name of files.names) {
      ctx.throwIfAborted();
      try {
        await processEntry(files, name, xhtml, metadata, ctx);
      } catch (error) {
        if (isFatal(error, ctx)) throw error;
        failure = error;
      }
    }
    if (failure !== undefined) {
      throw new MalformedDocumentError("Problem processing the iWork package", { cause: failure });
    }
    metadata.set("Content-Type", documentType(files.names, metadata));
    await xhtml.endDocument();
  }
}

async function processEntry(
  files: BoundedZip,
  name: string,
  xhtml: XHTMLContentHandler,
  metadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  if (name === PROPERTIES) {
    addProperties(files.get(name)!, metadata);
  } else if (name === BUILD_VERSION_HISTORY) {
    addVersionHistory(files.get(name)!, metadata);
  } else if (name === DOCUMENT_IDENTIFIER) {
    addDocumentIdentifier(files.get(name)!, metadata);
  } else if (name === PREVIEW) {
    await emitPackageEntry(xhtml, files.get(name)!, entryMetadata(name, "THUMBNAIL"), metadata, ctx);
  } else if (SKIPPED_PREVIEWS.has(name) || name.endsWith(".iwa")) {
    // Not read: the parts are protobuf Tika does not decode, and the small previews add nothing to the large one.
  } else {
    await emitPackageEntry(xhtml, files.get(name)!, entryMetadata(name), metadata, ctx);
  }
}

/** Each key of the properties dictionary as an iwork: field; any other root is ignored, as in Tika. */
function addProperties(bytes: Uint8Array, metadata: Metadata): void {
  const root = parsePlist(bytes);
  if (root.kind !== "dict") return;
  for (const [key, value] of root.value) metadata.add(IWORKS_PREFIX + key, plistText(value));
}

function addVersionHistory(bytes: Uint8Array, metadata: Metadata): void {
  const root = parsePlist(bytes);
  if (root.kind !== "array") return;
  for (const item of root.value) metadata.add(`${IWORKS_PREFIX}build-version-history`, plistText(item));
}

/**
 * The document's UUID: the first 36 bytes as ISO-8859-1, and nothing at all if the entry is shorter. Not TextDecoder("latin1"),
 * which the Encoding Standard makes windows-1252: it would turn a byte of 0x80 to 0x9F into a character Java's ISO_8859_1 does not.
 */
function addDocumentIdentifier(bytes: Uint8Array, metadata: Metadata): void {
  if (bytes.byteLength < DOCUMENT_ID_BYTES) return;
  metadata.set(`${IWORKS_PREFIX}document-id`, String.fromCharCode(...bytes.subarray(0, DOCUMENT_ID_BYTES)));
}

/**
 * Only a Keynote package has parts that say what it is (Slide and MasterSlide); the main Document.iwa would need its
 * protobuf decoded. The rest are typed by the file name, if the caller gave one.
 */
function documentType(names: readonly string[], metadata: Metadata): string {
  for (const name of names) if (isKeynotePart(name)) return KEYNOTE;
  return typeByExtension(metadata.get(TIKA_KEYS.RESOURCE_NAME));
}

function isKeynotePart(name: string): boolean {
  if (!name.endsWith(".iwa")) return false;
  return (
    name === "Index/MasterSlide.iwa" ||
    name.startsWith("Index/MasterSlide-") ||
    name === "Index/Slide.iwa" ||
    name.startsWith("Index/Slide-")
  );
}

function typeByExtension(fileName: string | null): string {
  if (fileName === null) return UNKNOWN;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".numbers")) return NUMBERS;
  if (lower.endsWith(".pages")) return PAGES;
  if (lower.endsWith(".key")) return KEYNOTE;
  return UNKNOWN;
}
