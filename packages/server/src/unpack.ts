import type { ServerMimeType } from "./mime-types.ts";

/** What an entry without a type or an extension is called, as Tika's `FilenameUtils.calculateExtension` default. */
export const DEFAULT_EXTENSION = ".bin";

/**
 * The extension Tika gives an embedded document: that of its registered media type, the type's first plain `*.ext`
 * glob. A `Content-Type` with parameters (`text/plain; charset=windows-1252`) is, to Tika's registry, not a registered
 * type, so it has none: `.bin`. A type the registry does not know, or knows without an extension, is `.bin` too.
 */
export function extensionFor(contentType: string | null, mimeTypes: readonly ServerMimeType[] | undefined): string {
  if (contentType === null || contentType.includes(";") || mimeTypes === undefined) return DEFAULT_EXTENSION;
  // Tika's `calculateExtension` reads an OCR routing type (`image/ocr-png`) as the image type it came from.
  const wanted = contentType.trim().toLowerCase().replace(/^image\/ocr-/, "image/");
  const known = mimeTypes.find(
    (candidate) => candidate.type.toLowerCase() === wanted || candidate.aliases?.some((alias) => alias.toLowerCase() === wanted) === true,
  );
  const [extension] = known?.extensions ?? [];
  return extension === undefined || extension.trim() === "" ? DEFAULT_EXTENSION : extension;
}
