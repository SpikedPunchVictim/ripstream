import {
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { emitPackageEntry, entryMetadata, openPackage } from "./iwork-package.ts";
import { isFatal } from "./failures.ts";

/*
 * Port of Tika 4.2.0's IWork18PackageParser: the 2018 iWork layout, a ZIP holding one directory named like the document
 * (Presentation.key/ with Metadata/, Index/ and preview.jpg in it). Tika types the package from that directory's name and
 * emits the preview as a thumbnail; the content itself is not parsed there either. Read from that source and its
 * IWork18ParserTest; not run against a Tika.
 */

const KEYNOTE = "application/vnd.apple.keynote.18";
const NUMBERS = "application/vnd.apple.numbers.18";
const PAGES = "application/vnd.apple.pages.18";

const VERSION_HISTORY = "/Metadata/BuildVersionHistory.plist";

export class IWork18Parser implements Parser {
  readonly name = "IWork18PackageParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([KEYNOTE, NUMBERS, PAGES].map((type) => MediaType.parseOrThrow(type)));
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

    let type: string | undefined;
    for (const name of files.names) {
      ctx.throwIfAborted();
      type ??= typeOfEntry(name);
      if (isPreview(name)) {
        // Tika's ZipFile path checks canReadEntryData first and skips a preview it cannot read.
        try {
          const bytes = files.get(name);
          if (bytes !== undefined) {
            const embedded = entryMetadata(name, "THUMBNAIL");
            embedded.set("Content-Type", "image/jpeg");
            await emitPackageEntry(xhtml, bytes, embedded, metadata, ctx);
          }
        } catch (error) {
          if (isFatal(error, ctx)) throw error;
        }
      }
    }
    if (type !== undefined) metadata.set("Content-Type", type);
    await xhtml.endDocument();
  }
}

/** The type a Metadata/BuildVersionHistory.plist entry names by the extension of the directory that holds it. */
function typeOfEntry(name: string): string | undefined {
  if (name.endsWith(`.numbers${VERSION_HISTORY}`)) return NUMBERS;
  if (name.endsWith(`.pages${VERSION_HISTORY}`)) return PAGES;
  if (name.endsWith(`.key${VERSION_HISTORY}`)) return KEYNOTE;
  return undefined;
}

/** The document preview: preview.jpg at the root or inside any directory of the package. */
function isPreview(name: string): boolean {
  return name === "preview.jpg" || name.endsWith("/preview.jpg");
}
