import {
  TIKA_MIME_REGISTRY,
  parseCustomMimeTypes,
  readCustomMimeTypesFile,
  withCustomMimeTypes,
} from "@spikedpunch/ripstream-bundle-standard";
import type { ServerMimeType } from "@spikedpunch/ripstream-server";

/** A glob that names an extension and nothing else: `*.txt`. */
const EXTENSION_GLOB = /^\*(\.[^*?[\]\\]+)$/;

/**
 * The media types `ripstream serve` describes at `/mime-types`: the standard registry with the file the configuration's
 * `custom-mimetypes` names merged in, as the detector reads them.
 */
export function serverMimeTypes(customMimeTypesPath: string | null): ServerMimeType[] {
  const custom =
    customMimeTypesPath === null ? [] : parseCustomMimeTypes(readCustomMimeTypesFile(customMimeTypesPath), customMimeTypesPath);
  return withCustomMimeTypes(TIKA_MIME_REGISTRY, custom).map((entry) => ({
    type: entry.type,
    aliases: entry.aliases,
    ...(entry.supertype === undefined ? {} : { supertype: entry.supertype }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    extensions: entry.globs.flatMap((glob) => EXTENSION_GLOB.exec(glob)?.[1] ?? []),
  }));
}
