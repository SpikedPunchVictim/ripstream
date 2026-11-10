import { MediaType, MediaTypeRegistry, RipstreamConfigError } from "@spikedpunch/ripstream-core";
import { compileJavaFullMatch } from "./magic.ts";
import type { TikaMagic, TikaMimeEntry, TikaRootXml } from "./registry-types.ts";
import { TIKA_MIME_REGISTRY } from "./generated/registry.ts";

interface CompiledGlob {
  /** The pattern as written. */
  readonly source: string;
  /** Tika's key for it: a glob's compiled regular expression, or the regular expression as written. */
  readonly key: string;
  readonly regex: RegExp;
  readonly type: MediaType;
}

export interface CustomMimeType {
  readonly type: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly globs?: readonly string[];
  /** Java regular expressions that must match the whole file name (`<glob isregex="true">`). */
  readonly regexGlobs?: readonly string[];
  readonly supertype?: string;
  readonly rootXml?: readonly TikaRootXml[];
  readonly magic?: readonly TikaMagic[];
  /** Replace the base entry of the same type instead of merging into it. */
  readonly override?: boolean;
}

export interface MimeTypesOptions {
  readonly registry?: readonly TikaMimeEntry[];
  readonly custom?: readonly CustomMimeType[];
}

/**
 * Runtime view of the generated Tika MIME registry. Mirrors upstream
 * MimeTypes/MediaTypeRegistry lookup, alias normalization, and glob priority
 * (longest pattern first, then lexicographic).
 */
export class MimeTypes {
  private readonly mediaTypeRegistry = new MediaTypeRegistry();
  private readonly byType = new Map<string, TikaMimeEntry>();
  private readonly aliases = new Map<string, MediaType>();
  private readonly globs: CompiledGlob[] = [];
  private readonly globsByKey = new Map<string, CompiledGlob>();
  private readonly extensions = new Map<string, MediaType>();
  private minExtensionLength = Number.POSITIVE_INFINITY;
  private maxExtensionLength = 0;
  private readonly exactNames = new Map<string, MediaType>();
  private readonly merged: readonly TikaMimeEntry[];
  /** The patterns custom definitions name: they are held to Tika's conflict rule. Tika's own registry keeps its order. */
  private readonly customPatterns: ReadonlySet<string>;
  private readonly xmlRoots: Array<{ entry: TikaMimeEntry; root: TikaRootXml }> = [];

  constructor(options: MimeTypesOptions = {}) {
    const custom = options.custom ?? [];
    const entries = withCustomMimeTypes(options.registry ?? TIKA_MIME_REGISTRY, custom);
    this.merged = entries;
    this.customPatterns = new Set(custom.flatMap((type) => [...(type.globs ?? []), ...(type.regexGlobs ?? [])]));

    for (const entry of entries) {
      const type = MediaType.parse(entry.type);
      if (type === null) continue;
      this.byType.set(type.toString(), entry);
      this.mediaTypeRegistry.addType(type);

      for (const alias of entry.aliases) {
        const aliasType = MediaType.parse(alias);
        if (aliasType === null) continue;
        this.aliases.set(aliasType.getBaseType().toString(), type.getBaseType());
        this.mediaTypeRegistry.addAlias(type, aliasType);
      }

      if (entry.supertype !== undefined) {
        const parent = MediaType.parse(entry.supertype);
        if (parent !== null) this.mediaTypeRegistry.addSuperType(type, parent);
      }

      for (const root of entry.rootXml) this.xmlRoots.push({ entry, root });

      for (const pattern of entry.globs) {
        this.addPattern(pattern, type);
      }
      for (const pattern of entry.regexGlobs ?? []) {
        this.addRegexPattern(pattern, type);
      }
    }

    // Tika's LengthComparator: the longer key first, then the key itself.
    this.globs.push(...this.globsByKey.values());
    this.globs.sort((a, b) => b.key.length - a.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * Tika's `Patterns.add`, for what a custom definition names: a name, an extension or a glob that two types claim goes
   * to the more general type when one is a specialization of the other, and is a conflict (the registry is refused)
   * when they are unrelated. Tika applies this as it reads each element in turn, so a pattern that precedes its type's
   * `sub-class-of` in the file is judged without it, which an entry here cannot say; the registry Tika ships has such
   * a pattern (`application/x-geopackage; version=1.1Or1.0`), so its own patterns keep what they always had: the first
   * type to claim a pattern keeps it.
   */
  private addPattern(pattern: string, type: MediaType): void {
    if (!/[*?[]/.test(pattern)) {
      if (this.contest(pattern, this.exactNames.get(pattern), type, `name pattern: ${pattern}`)) this.exactNames.set(pattern, type);
      return;
    }

    if (pattern.startsWith("*") && !/[*?[]/.test(pattern.slice(1))) {
      const suffix = pattern.slice(1);
      if (this.contest(pattern, this.extensions.get(suffix), type, `extension pattern: ${suffix}`)) {
        this.extensions.set(suffix, type);
        this.minExtensionLength = Math.min(this.minExtensionLength, suffix.length);
        this.maxExtensionLength = Math.max(this.maxExtensionLength, suffix.length);
      }
      return;
    }

    this.addGlob({ source: pattern, key: tikaGlobKey(pattern), regex: globToRegExp(pattern), type });
  }

  private addRegexPattern(pattern: string, type: MediaType): void {
    const regex = compileJavaFullMatch(pattern);
    if (regex === null) {
      throw new RipstreamConfigError([`glob regular expression "${pattern}" of ${type.toString()} cannot be run by ripstream`]);
    }
    this.addGlob({ source: pattern, key: pattern, regex, type });
  }

  private addGlob(glob: CompiledGlob): void {
    if (this.contest(glob.source, this.globsByKey.get(glob.key)?.type, glob.type, `glob pattern: ${glob.source}`)) {
      this.globsByKey.set(glob.key, glob);
    }
  }

  /** True when `type` takes the pattern over from `previous`; false when `previous` keeps it. */
  private contest(pattern: string, previous: MediaType | undefined, type: MediaType, what: string): boolean {
    if (!this.customPatterns.has(pattern)) return previous === undefined;
    if (previous === undefined || this.mediaTypeRegistry.isSpecializationOf(previous, type)) return true;
    if (previous.equals(type) || this.mediaTypeRegistry.isSpecializationOf(type, previous)) return false;
    throw new RipstreamConfigError([`Conflicting ${what} (${previous.toString()} and ${type.toString()})`]);
  }

  /** The registry as built: Tika's entries with the custom definitions merged in. */
  getEntries(): readonly TikaMimeEntry[] {
    return this.merged;
  }

  get registeredCount(): number {
    return this.byType.size;
  }

  getMediaTypeRegistry(): MediaTypeRegistry {
    return this.mediaTypeRegistry;
  }

  normalize(type: MediaType | null): MediaType | null {
    return this.mediaTypeRegistry.normalize(type);
  }

  getRegisteredMimeType(value: string | MediaType): MediaType | null {
    const type = typeof value === "string" ? MediaType.parse(value) : value;
    if (type === null) return null;

    const normalized = this.mediaTypeRegistry.normalize(type);
    if (normalized === null) return null;

    const entry = this.byType.get(normalized.getBaseType().toString());
    return entry === undefined ? null : (MediaType.parse(entry.type) ?? normalized);
  }

  getMimeType(name: string): MediaType | null {
    return this.forName(name);
  }

  /** Upstream getMimeType falls back to octet-stream. */
  getMimeTypeOrOctetStream(name: string): MediaType {
    return this.forName(name) ?? MediaType.OCTET_STREAM;
  }

  forName(name: string): MediaType | null {
    const exact = this.exactNames.get(name);
    if (exact !== undefined) return exact;

    for (let length = Math.min(this.maxExtensionLength, name.length); length >= this.minExtensionLength; length--) {
      const type = this.extensions.get(name.slice(name.length - length));
      if (type !== undefined) return type;
    }

    for (const glob of this.globs) {
      if (glob.regex.test(name)) return glob.type;
    }

    return null;
  }

  forRootXML(localName: string, namespaceURI?: string): MediaType | null {
    for (const { entry, root } of this.xmlRoots) {
      if (root.localName !== localName) continue;
      if (
        root.namespaceURI !== undefined &&
        namespaceURI !== undefined &&
        root.namespaceURI !== namespaceURI
      ) {
        continue;
      }
      return MediaType.parse(entry.type);
    }
    return null;
  }

  getEntry(type: MediaType | string): TikaMimeEntry | null {
    const parsed = typeof type === "string" ? MediaType.parse(type) : type;
    if (parsed === null) return null;
    const normalized = this.mediaTypeRegistry.normalize(parsed);
    if (normalized === null) return null;
    return this.byType.get(normalized.getBaseType().toString()) ?? null;
  }

  getMagic(): ReadonlyArray<{ type: MediaType; magic: TikaMagic }> {
    const magics: Array<{ type: MediaType; magic: TikaMagic }> = [];
    for (const entry of this.byType.values()) {
      const type = MediaType.parse(entry.type);
      if (type === null) continue;
      for (const magic of entry.magic) magics.push({ type, magic });
    }
    return magics;
  }

  getGlobs(): readonly string[] {
    return [...this.exactNames.keys(), ...this.getExtensions().map((suffix) => `*${suffix}`), ...this.globs.map((g) => g.source)];
  }

  getExtensions(): readonly string[] {
    return [...this.extensions.keys()].sort((a, b) => b.length - a.length);
  }

  isSpecializationOf(type: MediaType, parent: MediaType): boolean {
    return this.mediaTypeRegistry.isSpecializationOf(type, parent);
  }

  getSupertype(type: MediaType): MediaType | null {
    return this.mediaTypeRegistry.getSupertype(type);
  }
}

/** `Patterns.compile`: the regular expression Tika builds from a glob, which is also how it tells two globs apart. */
function tikaGlobKey(glob: string): string {
  let key = "\\A";
  for (const char of glob) {
    if (char === "?") key += ".";
    else if (char === "*") key += ".*";
    else if ("\\[]^.-$+(){}|".includes(char)) key += `\\${char}`;
    else key += char;
  }
  return `${key}\\z`;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    switch (char) {
      case "*":
        source += ".*";
        break;
      case "?":
        source += ".";
        break;
      case "[":
      case "]":
        source += `\\${char}`;
        break;
      case "\\":
      case "^":
      case "$":
      case ".":
      case "+":
      case "(":
      case ")":
      case "{":
      case "}":
      case "|":
        source += `\\${char}`;
        break;
      default:
        source += char;
    }
  }
  return new RegExp(`${source}$`, "u");
}

/** Extracts a filename from Content-Disposition, including RFC 2231/5987. */
export function filenameFromContentDisposition(header: string): string | null {
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended !== null) {
    const encoding = extended[1]!.trim().toLowerCase();
    const raw = extended[2]!.trim().replace(/^"|"$/g, "");
    if (encoding === "utf-8" || encoding === "utf8" || encoding === "") {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted !== null) return quoted[1]!.replace(/\\(.)/g, "$1");

  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  return plain === null ? null : plain[1]!.trim();
}

/**
 * The registry with custom definitions merged in, as Tika's reader does when it reads a second file: a type that is
 * already there (by name or by alias) gains the new aliases, globs, root elements and magic and takes a new supertype
 * and description; a type that is not is added. `override` replaces the entry instead.
 */
export function withCustomMimeTypes(
  base: readonly TikaMimeEntry[],
  custom: readonly CustomMimeType[],
): TikaMimeEntry[] {
  if (custom.length === 0) return [...base];
  const entries = base.map((entry) => ({ ...entry }));
  const indexes = new Map<string, number>();
  // Names a custom type may use for a type that is already there: Tika's forName normalizes through the aliases.
  const known = new MediaTypeRegistry();
  const canonical = (type: string): string => {
    const parsed = MediaType.parse(type);
    return parsed === null ? type : (known.normalize(parsed) ?? parsed).toString();
  };
  const register = (position: number): void => {
    const entry = entries[position]!;
    const type = MediaType.parse(entry.type);
    if (type === null) return;
    known.addType(type);
    for (const alias of entry.aliases) {
      const parsed = MediaType.parse(alias);
      if (parsed !== null) known.addAlias(type, parsed);
    }
    indexes.set(canonical(entry.type), position);
  };
  entries.forEach((_, position) => register(position));

  for (const addition of custom) {
    const position = indexes.get(canonical(addition.type));
    const fresh: TikaMimeEntry = {
      type: addition.type,
      ...(addition.description === undefined ? {} : { description: addition.description }),
      aliases: [...(addition.aliases ?? [])],
      globs: [...(addition.globs ?? [])],
      ...(addition.regexGlobs === undefined || addition.regexGlobs.length === 0 ? {} : { regexGlobs: [...addition.regexGlobs] }),
      ...(addition.supertype === undefined ? {} : { supertype: addition.supertype }),
      rootXml: [...(addition.rootXml ?? [])],
      magic: [...(addition.magic ?? [])],
    };
    if (position === undefined) {
      entries.push(fresh);
      register(entries.length - 1);
      continue;
    }
    if (addition.override === true) {
      entries[position] = fresh;
      register(position);
      continue;
    }
    const existing = entries[position]!;
    const supertype = addition.supertype ?? existing.supertype;
    const description = addition.description ?? existing.description;
    const regexGlobs = [...new Set([...(existing.regexGlobs ?? []), ...(addition.regexGlobs ?? [])])];
    entries[position] = {
      ...existing,
      ...(description === undefined ? {} : { description }),
      aliases: [...new Set([...existing.aliases, ...(addition.aliases ?? [])])],
      globs: [...new Set([...existing.globs, ...(addition.globs ?? [])])],
      ...(regexGlobs.length === 0 ? {} : { regexGlobs }),
      rootXml: [...existing.rootXml, ...(addition.rootXml ?? [])],
      magic: [...existing.magic, ...(addition.magic ?? [])],
      ...(supertype === undefined ? {} : { supertype }),
    };
    register(position);
  }
  return entries;
}
