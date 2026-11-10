import { MediaType, RipstreamConfigError } from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";
import type { TikaMagic, TikaMatch, TikaMimeEntry, TikaRootXml } from "./registry-types.ts";

/** The match types Tika's `MagicDetector.parse` decodes. Any other type has no pattern and fails at the first detect. */
const MATCH_TYPES: ReadonlySet<string> = new Set([
  "string",
  "stringignorecase",
  "regex",
  "unicodeLE",
  "unicodeBE",
  "byte",
  "host16",
  "little16",
  "big16",
  "host32",
  "little32",
  "big32",
]);
const NUMERIC_MATCH_TYPES: ReadonlySet<string> = new Set(["host16", "little16", "big16", "host32", "little32", "big32"]);

/** Elements that describe a type for people. Tika reads them into properties that detection never consults. */
const DESCRIPTIVE = new Set(["_comment", "comment", "acronym", "expanded-acronym", "tika:link", "tika:uti"]);

interface MutableMatch {
  type: string;
  value: string;
  offset: string;
  mask?: string;
  minShouldMatch?: number;
  children: MutableMatch[];
}

interface MutableMagic {
  priority: number;
  matches: MutableMatch[];
}

interface MutableEntry {
  type: string;
  description: string | undefined;
  aliases: string[];
  globs: string[];
  regexGlobs: string[];
  supertype: string | undefined;
  rootXml: TikaRootXml[];
  magic: MutableMagic[];
}

/**
 * Reads a freedesktop mime-info document in the shape Tika reads (its own tika-mimetypes.xml and the
 * `custom-mimetypes.xml` of `tika.custom-mimetypes`): one entry per `<mime-type>` element, in document order.
 *
 * Tika is lenient where a mistake changes nothing at load and fails later (a magic match of an unknown type throws at
 * the first detect) or never (a misspelled element, a `<glob>` without a pattern). A definition ripstream would
 * ignore is a configuration error here, so every such mistake is refused by name, all of them in one error. This is
 * the reader for files an operator supplies; `scripts/generate.ts` reads Tika's own registry, which has the same
 * irregularities (a `<glob>` inside a `<magic>`, a `<match>` without an offset) and keeps its leniency.
 *
 * `source` names the file in each message.
 */
export function parseMimeTypesXml(xml: string, source: string): TikaMimeEntry[] {
  const issues: string[] = [];
  const entries: TikaMimeEntry[] = [];
  const parser = new SaxesParser({ xmlns: false, position: true });
  const issue = (message: string): void => {
    issues.push(`${source}:${parser.line}: ${message}`);
  };

  const path: string[] = [];
  let entry: MutableEntry | null = null;
  let magic: MutableMagic | null = null;
  const matches: MutableMatch[] = [];
  let description: string | null = null;

  const attribute = (attributes: Record<string, string>, name: string, element: string): string | undefined => {
    const value = attributes[name];
    if (value === undefined || value === "") issue(`<${element}> needs a ${name} attribute`);
    return value === undefined || value === "" ? undefined : value;
  };
  const integer = (text: string, name: string, element: string): number | undefined => {
    if (/^\d+$/.test(text)) return Number(text);
    issue(`<${element}> ${name} "${text}" is not a non-negative integer`);
    return undefined;
  };

  parser.on("error", (error) => {
    issues.push(`${source}: not well-formed XML: ${error.message.split("\n")[0] ?? error.message}`);
  });

  parser.on("opentag", (tag) => {
    const attributes = tag.attributes as Record<string, string>;
    const parent = path.at(-1);
    path.push(tag.name);

    if (parent === undefined) {
      if (tag.name !== "mime-info") issue(`the root element is <${tag.name}>, not <mime-info>`);
      return;
    }
    if (parent === "mime-info") {
      if (tag.name !== "mime-type") {
        issue(`<${tag.name}> is not a <mime-info> child ripstream knows (expected <mime-type>)`);
        return;
      }
      const type = attribute(attributes, "type", "mime-type");
      const parsed = type === undefined ? null : MediaType.parse(type);
      if (type !== undefined && parsed === null) issue(`<mime-type> type "${type}" is not a media type`);
      entry =
        parsed === null || type === undefined
          ? null
          : { type, description: undefined, aliases: [], globs: [], regexGlobs: [], supertype: undefined, rootXml: [], magic: [] };
      return;
    }
    if (entry === null) return; // inside a <mime-type> already refused, or an element refused above

    if (parent === "mime-type") {
      switch (tag.name) {
        case "alias":
        case "sub-class-of": {
          const type = attribute(attributes, "type", tag.name);
          if (type === undefined) break;
          if (MediaType.parse(type) === null) {
            issue(`<${tag.name}> type "${type}" is not a media type`);
          } else if (tag.name === "alias") {
            entry.aliases.push(type);
          } else {
            entry.supertype = type;
          }
          break;
        }
        case "glob": {
          const pattern = attribute(attributes, "pattern", "glob");
          const regex = attributes.isregex;
          if (regex !== undefined && regex !== "true" && regex !== "false") {
            issue(`<glob> isregex "${regex}" is neither true nor false`);
          } else if (pattern !== undefined) {
            (regex === "true" ? entry.regexGlobs : entry.globs).push(pattern);
          }
          break;
        }
        case "root-XML": {
          const localName = attribute(attributes, "localName", "root-XML");
          if (localName === undefined) break;
          entry.rootXml.push({
            localName,
            ...(attributes.namespaceURI === undefined ? {} : { namespaceURI: attributes.namespaceURI }),
          });
          break;
        }
        case "magic": {
          const text = attributes.priority;
          const priority = text === undefined || text === "" ? 50 : integer(text, "priority", "magic");
          magic = { priority: priority ?? 50, matches: [] };
          entry.magic.push(magic);
          matches.length = 0;
          break;
        }
        default:
          if (DESCRIPTIVE.has(tag.name)) {
            if (tag.name === "_comment" || tag.name === "comment") description = "";
          } else {
            issue(`<${tag.name}> is not a <mime-type> child ripstream knows`);
          }
      }
      return;
    }

    if (parent === "magic" || parent === "match") {
      if (tag.name !== "match") {
        issue(`<${tag.name}> is not a <${parent}> child (expected <match>)`);
        return;
      }
      const match: MutableMatch = { type: "string", value: "", offset: "0", children: [] };
      if (attributes.minShouldMatch !== undefined) {
        const threshold = integer(attributes.minShouldMatch, "minShouldMatch", "match");
        if (threshold !== undefined) match.minShouldMatch = threshold;
      } else {
        const type = attributes.type ?? "string";
        if (!MATCH_TYPES.has(type)) issue(`<match> type "${type}" is not one of ${[...MATCH_TYPES].join(", ")}`);
        match.type = type;
        const value = attributes.value;
        if (value === undefined) {
          issue(`<match> needs a value attribute`);
        } else {
          match.value = value;
          const hex = value.startsWith("0x");
          if (NUMERIC_MATCH_TYPES.has(type) && !(hex ? /^0x[0-9a-fA-F]+$/ : /^[0-7]+$/).test(value)) {
            issue(`<match> value "${value}" is not ${hex ? "hexadecimal" : "octal (or 0x hexadecimal)"} for type ${type}`);
          }
        }
        const offset = attribute(attributes, "offset", "match");
        if (offset !== undefined) {
          if (/^\d+(:\d+)?$/.test(offset)) match.offset = offset;
          else issue(`<match> offset "${offset}" is not N or N:M`);
        }
        if (attributes.mask !== undefined) match.mask = attributes.mask;
      }
      const owner = matches.at(-1);
      if (owner !== undefined) owner.children.push(match);
      else magic?.matches.push(match);
      matches.push(match);
    }
  });

  parser.on("text", (text) => {
    if (description !== null) description += text;
  });

  parser.on("closetag", (tag) => {
    path.pop();
    if (tag.name === "match") matches.pop();
    if (tag.name === "magic") {
      matches.length = 0;
      magic = null;
    }
    if ((tag.name === "_comment" || tag.name === "comment") && entry !== null && description !== null) {
      const text = description.trim();
      if (text.length > 0) entry.description = text;
      description = null;
    }
    if (tag.name === "mime-type" && path.at(-1) === "mime-info" && entry !== null) {
      entries.push(finish(entry));
      entry = null;
    }
  });

  try {
    parser.write(xml).close();
  } catch {
    // Reported by the "error" listener, which saxes calls before it throws.
  }
  if (issues.length > 0) throw new RipstreamConfigError(issues);
  return entries;
}

function finish(entry: MutableEntry): TikaMimeEntry {
  return {
    type: entry.type,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    aliases: entry.aliases,
    globs: entry.globs,
    ...(entry.regexGlobs.length === 0 ? {} : { regexGlobs: entry.regexGlobs }),
    ...(entry.supertype === undefined ? {} : { supertype: entry.supertype }),
    rootXml: entry.rootXml,
    magic: entry.magic.map(
      (rule): TikaMagic => ({ priority: rule.priority, matches: prune(rule.matches) }),
    ),
  };
}

function prune(matches: readonly MutableMatch[]): TikaMatch[] {
  return matches.map((match) => ({
    type: match.type,
    value: match.value,
    offset: match.offset,
    ...(match.mask === undefined ? {} : { mask: match.mask }),
    ...(match.minShouldMatch === undefined ? {} : { minShouldMatch: match.minShouldMatch }),
    ...(match.children.length === 0 ? {} : { children: prune(match.children) }),
  }));
}
