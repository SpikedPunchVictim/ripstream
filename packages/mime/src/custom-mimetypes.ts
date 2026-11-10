import { readFileSync } from "node:fs";
import { RipstreamConfigError } from "@spikedpunch/ripstream-core";
import { MagicDetector } from "./magic.ts";
import { parseMimeTypesXml } from "./mimetypes-xml.ts";
import type { TikaMimeEntry } from "./registry-types.ts";

/**
 * The text of the file a configuration's `custom-mimetypes` names, read as Tika reads `tika.custom-mimetypes`: a path
 * (relative to the working directory) that must exist. A missing or unreadable file is a configuration error naming
 * the path, not a registry silently without the types.
 */
export function readCustomMimeTypesFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new RipstreamConfigError([
      code === "ENOENT"
        ? `custom-mimetypes: the file ${JSON.stringify(path)} does not exist`
        : `custom-mimetypes: the file ${JSON.stringify(path)} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

/**
 * The definitions in the text of a custom-mimetypes file, checked as far as they can be before the first document:
 * Tika compiles a magic match when it first runs it, so a pattern that cannot be decoded or run fails every later
 * detection there; here it fails now, naming the type.
 */
export function parseCustomMimeTypes(text: string, source: string): TikaMimeEntry[] {
  const entries = parseMimeTypesXml(text.startsWith("﻿") ? text.slice(1) : text, source);
  const failed = new MagicDetector(entries).uncompilableRegexes;
  if (failed.length > 0) {
    throw new RipstreamConfigError(
      failed.map((regex) => `${source}: the magic regular expression of ${regex} cannot be run by ripstream`),
    );
  }
  return entries;
}
