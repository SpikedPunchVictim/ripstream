import { MediaType } from "@spikedpunch/ripstream-core";
import { extractXmlRoot } from "../xml-root.ts";
import type { ZipArchive } from "./zip-archive.ts";

/** Port of Tika 4.2.0 `IWorkDetector`: iWork 2018 first, then 2013, then the 2009 XML packages. */

const IWORK09_COMMON_ENTRY = "buildVersionHistory.plist";
const IWORK09_CONTENT_ENTRIES = ["index.apxl", "index.xml", "presentation.apxl"] as const;
const IWORK13_COMMON_ENTRY = "Metadata/BuildVersionHistory.plist";
/** An iWork 2009 index is tens of MB; only its root element decides the type. */
const ROOT_PREFIX_BYTES = 64 * 1024;

const IWORK09_ROOTS: readonly { namespace: string; local: string; type: string }[] = [
  { namespace: "http://developer.apple.com/namespaces/keynote2", local: "presentation", type: "application/vnd.apple.keynote" },
  { namespace: "http://developer.apple.com/namespaces/ls", local: "document", type: "application/vnd.apple.numbers" },
  { namespace: "http://developer.apple.com/namespaces/sl", local: "document", type: "application/vnd.apple.pages" },
];

export async function detectIWork(zip: ZipArchive): Promise<MediaType | null> {
  const names = zip.entries.map((entry) => entry.name);
  return detectIWork18(names) ?? detectIWork13(zip, names) ?? (await detectIWork09(zip));
}

function detectIWork18(names: readonly string[]): MediaType | null {
  for (const name of names) {
    if (name.endsWith(".numbers/Metadata/BuildVersionHistory.plist")) return parse("application/vnd.apple.numbers.18");
    if (name.endsWith(".pages/Metadata/BuildVersionHistory.plist")) return parse("application/vnd.apple.pages.18");
    if (name.endsWith(".key/Metadata/BuildVersionHistory.plist")) return parse("application/vnd.apple.keynote.18");
  }
  return null;
}

function detectIWork13(zip: ZipArchive, names: readonly string[]): MediaType | null {
  if (!zip.has(IWORK13_COMMON_ENTRY)) return null;
  for (const name of names) {
    if (!name.endsWith(".iwa")) continue;
    // Only the keynote slide parts name their document type; Index/Document.iwa would need its protobuf decoded.
    if (
      name === "Index/MasterSlide.iwa" ||
      name.startsWith("Index/MasterSlide-") ||
      name === "Index/Slide.iwa" ||
      name.startsWith("Index/Slide-")
    ) {
      return parse("application/vnd.apple.keynote.13");
    }
  }
  return parse("application/vnd.apple.unknown.13");
}

async function detectIWork09(zip: ZipArchive): Promise<MediaType | null> {
  if (!zip.has(IWORK09_COMMON_ENTRY)) return null;
  for (const entry of IWORK09_CONTENT_ENTRIES) {
    const prefix = await zip.readPrefix(entry, ROOT_PREFIX_BYTES);
    if (prefix === null) continue;
    const root = extractXmlRoot(prefix);
    if (root === null) continue;
    const match = IWORK09_ROOTS.find(
      (candidate) => candidate.namespace === root.namespaceURI && candidate.local === root.localName,
    );
    if (match !== undefined) return parse(match.type);
  }
  return parse("application/vnd.apple.iwork");
}

function parse(value: string): MediaType {
  const parsed = MediaType.parse(value);
  if (parsed === null) throw new Error(`invalid media type literal: ${value}`);
  return parsed;
}
