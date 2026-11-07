import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import type {
  TikaMagic,
  TikaMatch,
  TikaMimeEntry,
  TikaRootXml,
} from "../src/registry-types.ts";

const source = new URL("../data/tika-mimetypes.xml", import.meta.url);
const output = new URL("../src/generated/registry.ts", import.meta.url);
const xml = readFileSync(source, "utf8");
const checksum = createHash("sha256").update(xml).digest("hex");

interface MutableEntry {
  type: string;
  description?: string;
  aliases: string[];
  globs: string[];
  supertype?: string;
  rootXml: TikaRootXml[];
  magic: TikaMagic[];
}

interface MutableMatch {
  type: string;
  value: string;
  offset: string;
  mask?: string;
  minShouldMatch?: number;
  children?: MutableMatch[];
}

const entries: MutableEntry[] = [];
let currentEntry: MutableEntry | null = null;
let currentMagic: { priority: number; matches: MutableMatch[] } | null = null;
let currentDescription: string | null = null;
const matchStack: MutableMatch[] = [];

const parser = new SaxesParser({ xmlns: false });

parser.on("opentag", (tag) => {
  const attributes = tag.attributes as Record<string, string>;

  switch (tag.name) {
    case "mime-type": {
      const type = attributes.type;
      if (type === undefined) throw new Error("mime-type without type");
      currentEntry = {
        type,
        aliases: [],
        globs: [],
        rootXml: [],
        magic: [],
      };
      entries.push(currentEntry);
      break;
    }
    case "_comment":
    case "comment":
      currentDescription = "";
      break;
    case "alias": {
      if (currentEntry === null) break;
      if (attributes.type !== undefined) currentEntry.aliases.push(attributes.type);
      break;
    }
    case "glob": {
      if (currentEntry === null) break;
      if (attributes.pattern !== undefined) currentEntry.globs.push(attributes.pattern);
      break;
    }
    case "sub-class-of": {
      if (currentEntry === null) break;
      if (attributes.type !== undefined) currentEntry.supertype = attributes.type;
      break;
    }
    case "root-XML": {
      if (currentEntry === null) break;
      if (attributes.localName !== undefined) {
        currentEntry.rootXml.push({
          localName: attributes.localName,
          ...(attributes.namespaceURI === undefined
            ? {}
            : { namespaceURI: attributes.namespaceURI }),
        });
      }
      break;
    }
    case "magic": {
      if (currentEntry === null) break;
      currentMagic = {
        priority: Number(attributes.priority ?? "50"),
        matches: [],
      };
      currentEntry.magic.push(currentMagic);
      matchStack.length = 0;
      break;
    }
    case "match": {
      if (currentEntry === null || currentMagic === null) break;
      const match: MutableMatch = {
        type: attributes.type ?? "string",
        value: attributes.value ?? "",
        offset: attributes.offset ?? "0",
        ...(attributes.mask === undefined ? {} : { mask: attributes.mask }),
        ...(attributes.minShouldMatch === undefined
          ? {}
          : { minShouldMatch: Number(attributes.minShouldMatch) }),
        children: [],
      };

      const parent = matchStack.at(-1);
      if (parent === undefined) currentMagic.matches.push(match);
      else parent.children!.push(match);
      matchStack.push(match);
      break;
    }
  }
});

parser.on("text", (text) => {
  if (currentDescription !== null) currentDescription += text;
});

parser.on("closetag", (tag) => {
  if (tag.name === "match") matchStack.pop();
  if (tag.name === "magic") {
    currentMagic = null;
    matchStack.length = 0;
  }
  if (tag.name === "mime-type") {
    if (currentEntry !== null && currentDescription !== null) {
      const description = currentDescription.trim();
      if (description.length > 0) currentEntry.description = description;
    }
    currentEntry = null;
    currentDescription = null;
  }
  if (tag.name === "_comment" || tag.name === "comment") {
    currentDescription = null;
  }
});

parser.write(xml).close();

const cleaned: TikaMimeEntry[] = entries.map((entry) => ({
  type: entry.type,
  ...(entry.description === undefined ? {} : { description: entry.description }),
  aliases: entry.aliases,
  globs: entry.globs,
  ...(entry.supertype === undefined ? {} : { supertype: entry.supertype }),
  rootXml: entry.rootXml,
  magic: entry.magic.map((magic) => ({
    priority: magic.priority,
    matches: prune(magic.matches),
  })),
}));

function prune(matches: readonly MutableMatch[]): TikaMatch[] {
  return matches.map((match) => ({
    type: match.type,
    value: match.value,
    offset: match.offset,
    ...(match.mask === undefined ? {} : { mask: match.mask }),
    ...(match.minShouldMatch === undefined
      ? {}
      : { minShouldMatch: match.minShouldMatch }),
    ...(match.children === undefined || match.children.length === 0
      ? {}
      : { children: prune(match.children) }),
  }));
}

const header = `// Generated from Apache Tika tika-mimetypes.xml. Do not edit.
// Source: ${source.href}
// SHA-256: ${checksum}
// Tika target: 4.2.0
import type { TikaMimeEntry } from "../registry-types.ts";

export const TIKA_MIMETYPES_SHA256 = "${checksum}";
export const TIKA_MIMETYPES_SOURCE = ${JSON.stringify(source.href)};
`;

const body = `export const TIKA_MIME_REGISTRY: readonly TikaMimeEntry[] = ${JSON.stringify(
  cleaned,
)};\n`;

writeFileSync(output, header + body);
console.log(
  `generated ${cleaned.length} mime types from ${fileURLToPath(source)} (${checksum})`,
);
