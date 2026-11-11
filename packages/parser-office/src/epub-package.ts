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
import { SaxesParser } from "saxes";
import type { BoundedZip } from "./bounded-unzip.ts";
import { describeFailure, isFatal } from "./failures.ts";
import { javaHashMapOrder } from "./java-hash-order.ts";
import { localName } from "./xml-tree.ts";

/*
 * The package document of an EPUB as Tika's EpubParser reads it (ContentOrderScraper), and what it does with the manifest items
 * that are not chapters: it hands each to the embedded-document extractor, with the cover image as the thumbnail. Read from
 * Tika 4.2.0, not run against a Tika.
 */

export interface ManifestItem {
  /** The entry name in the package: the OPF's folder, then the percent-decoded href. */
  readonly href: string;
  readonly properties: string;
  /** The media-type attribute, or null when the item has none. */
  readonly mediaType: string | null;
}

export interface PackageDocument {
  /** The manifest by id; the id put twice keeps its first place and takes the last item. */
  readonly manifest: Map<string, ManifestItem>;
  /** The idref of each spine itemref, in order. */
  readonly spine: string[];
  /** The manifest id of the cover image: the EPUB 3 cover-image property first, then the EPUB 2 cover meta. */
  readonly coverId: string | undefined;
}

/** Reads the manifest, the spine and the cover from an OPF; `base` is the OPF's folder, with its trailing slash. */
export function readPackageDocument(opfXml: string, base: string): PackageDocument {
  const manifest = new Map<string, ManifestItem>();
  const spine: string[] = [];
  let inManifest = false;
  let inSpine = false;
  let coverImageItem: string | undefined;
  let coverMetaItem: string | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    const name = localName(tag.name).toLowerCase();
    const attributes = tag.attributes as Record<string, string>;
    if (name === "manifest") inManifest = true;
    else if (name === "spine") inSpine = true;
    if (inManifest) {
      if (name !== "item" || attributes.id === undefined || attributes.href === undefined) return;
      manifest.set(attributes.id, {
        href: entryName(base, attributes.href),
        properties: attributes.properties ?? "",
        mediaType: attributes["media-type"] ?? null,
      });
      if (coverImageItem === undefined && hasProperty(attributes.properties, "cover-image")) {
        coverImageItem = attributes.id;
      }
    } else if (name === "meta" && coverMetaItem === undefined && attributes.name === "cover") {
      const content = attributes.content?.trim();
      if (content !== undefined && content.length > 0) coverMetaItem = content;
    }
    if (inSpine && name === "itemref" && attributes.idref !== undefined) spine.push(attributes.idref);
  });
  parser.on("closetag", (tag) => {
    const name = localName(tag.name).toLowerCase();
    if (name === "manifest") inManifest = false;
    else if (name === "spine") inSpine = false;
  });
  parser.write(opfXml).close();
  return { manifest, spine, coverId: coverImageItem ?? coverMetaItem };
}

function hasProperty(properties: string | undefined, wanted: string): boolean {
  return properties !== undefined && properties.trim().split(/\s+/).includes(wanted);
}

/**
 * The entry a manifest href names. Tika decodes the href with java.net.URLDecoder (a plus is a space) and appends it to the OPF's
 * folder; a fragment is cut and `..` folded here, which Tika does not do, so an href it would not find is found.
 */
function entryName(base: string, href: string): string {
  const parts = `${base}${decodeHref(href.split("#")[0]!)}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") stack.pop();
    else if (part !== "." && part.length > 0) stack.push(part);
  }
  return stack.join("/");
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href.replaceAll("+", " "));
  } catch (error) {
    throw new MalformedDocumentError(`An EPUB manifest href is not valid percent-encoding: ${href}`, { cause: error });
  }
}

/** Whether a spine item is read as a chapter: its media type says HTML, or it has none and its name ends like an HTML or XML file. */
export function isChapter(item: ManifestItem): boolean {
  if (item.mediaType !== null) return item.mediaType.toLowerCase().includes("html");
  const href = item.href.toLowerCase();
  return href.endsWith("htm") || href.endsWith("html") || href.endsWith(".xml");
}

/** Whether a manifest item that is not a chapter is handed to the extractor: not styles, SVG, XML, iBooks or the NCX. */
export function shouldHandleEmbedded(mediaType: string | null): boolean {
  if (mediaType === null) return true;
  const type = mediaType.toLowerCase();
  if (type.includes("css") || type.includes("svg") || type.endsWith("/xml") || type.includes("x-ibooks")) return false;
  return type !== "application/x-dtbncx+xml";
}

/** Hands every manifest item the chapters did not use to the extractor, in the order java.util.HashMap iterates their ids. */
export async function emitEmbeddedItems(
  document: PackageDocument,
  chapterIds: ReadonlySet<string>,
  files: BoundedZip,
  xhtml: XHTMLContentHandler,
  packageMetadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  for (const id of javaHashMapOrder([...document.manifest.keys()])) {
    const item = document.manifest.get(id)!;
    if (chapterIds.has(id) || !shouldHandleEmbedded(item.mediaType)) continue;
    await emitEmbeddedItem(item, id === document.coverId, files, xhtml, packageMetadata, ctx);
  }
}

async function emitEmbeddedItem(
  item: ManifestItem,
  cover: boolean,
  files: BoundedZip,
  xhtml: XHTMLContentHandler,
  packageMetadata: Metadata,
  ctx: ParseContext,
): Promise<void> {
  if (!files.has(item.href)) return;
  const embedded = embeddedMetadata(item, cover);
  const extractor =
    (ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor | undefined) ??
    new ParsingEmbeddedDocumentExtractor();
  if (!extractor.shouldParseEmbedded(embedded)) return;
  const bytes = readEntry(files, item.href, packageMetadata, ctx);
  if (bytes === undefined) return;
  const stream = await RipstreamInputStream.from(bytes, { context: ctx });
  try {
    await xhtml.startElement("div", "class", "embedded");
    try {
      await extractor.parseEmbedded(stream, xhtml, embedded, ctx);
    } catch (error) {
      recordFailure(error, packageMetadata, ctx);
    }
    await xhtml.endElement("div");
  } finally {
    await stream.close();
  }
}

/** Tika opens the entry once before it writes anything, so a broken entry is recorded and the item skipped. */
function readEntry(files: BoundedZip, name: string, packageMetadata: Metadata, ctx: ParseContext): Uint8Array | undefined {
  try {
    return files.get(name);
  } catch (error) {
    recordFailure(error, packageMetadata, ctx);
    return undefined;
  }
}

/** A failure of one embedded item is recorded on the package and the parse goes on; a limit, an abort or a timeout ends it. */
function recordFailure(error: unknown, packageMetadata: Metadata, ctx: ParseContext): void {
  if (isFatal(error, ctx)) throw error;
  // EmbeddedDocumentUtil.recordEmbeddedStreamException: the exception's name and message, not a stack trace.
  packageMetadata.add(TIKA_KEYS.EMBEDDED_STREAM_EXCEPTION, describeFailure(error));
}

function embeddedMetadata(item: ManifestItem, cover: boolean): Metadata {
  const metadata = new Metadata();
  if (item.mediaType !== null && item.mediaType.trim().length > 0) metadata.set("Content-Type", item.mediaType);
  metadata.set(TIKA_KEYS.RESOURCE_NAME, item.href);
  if (cover) metadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE, "THUMBNAIL");
  return metadata;
}
