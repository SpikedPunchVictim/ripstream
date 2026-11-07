import { MediaType, MediaTypeRegistry } from "@spikedpunch/ripstream-core";
import type { TikaMagic, TikaMimeEntry, TikaRootXml } from "./registry-types.ts";
import { TIKA_MIME_REGISTRY } from "./generated/registry.ts";

interface CompiledGlob {
  readonly source: string;
  readonly regex: RegExp;
  readonly type: MediaType;
}

export interface CustomMimeType {
  readonly type: string;
  readonly aliases?: readonly string[];
  readonly globs?: readonly string[];
  readonly supertype?: string;
  readonly rootXml?: readonly TikaRootXml[];
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
  private readonly extensions: Array<{ suffix: string; type: MediaType }> = [];
  private readonly exactNames = new Map<string, MediaType>();
  private readonly xmlRoots: Array<{ entry: TikaMimeEntry; root: TikaRootXml }> = [];

  constructor(options: MimeTypesOptions = {}) {
    const entries = mergeCustom(
      options.registry ?? TIKA_MIME_REGISTRY,
      options.custom ?? [],
    );

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
    }

    this.globs.sort((a, b) =>
      b.source.length - a.source.length || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
    );
    this.extensions.sort((a, b) => b.suffix.length - a.suffix.length);
  }

  private addPattern(pattern: string, type: MediaType): void {
    const hasWildcard = /[*?[]/.test(pattern);

    if (!hasWildcard) {
      if (!this.exactNames.has(pattern)) this.exactNames.set(pattern, type);
      return;
    }

    if (pattern.startsWith("*") && !/[*?[]/.test(pattern.slice(1))) {
      this.extensions.push({ suffix: pattern.slice(1), type });
      return;
    }

    this.globs.push({ source: pattern, regex: globToRegExp(pattern), type });
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

    for (const extension of this.extensions) {
      if (name.endsWith(extension.suffix)) return extension.type;
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
    return [...this.exactNames.keys(), ...this.extensions.map((e) => `*${e.suffix}`), ...this.globs.map((g) => g.source)];
  }

  getExtensions(): readonly string[] {
    return this.extensions.map((extension) => extension.suffix);
  }

  isSpecializationOf(type: MediaType, parent: MediaType): boolean {
    return this.mediaTypeRegistry.isSpecializationOf(type, parent);
  }

  getSupertype(type: MediaType): MediaType | null {
    return this.mediaTypeRegistry.getSupertype(type);
  }
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

function mergeCustom(
  base: readonly TikaMimeEntry[],
  custom: readonly CustomMimeType[],
): TikaMimeEntry[] {
  if (custom.length === 0) return [...base];
  const entries = base.map((entry) => ({ ...entry }));
  const indexes = new Map(entries.map((entry, index) => [entry.type, index]));
  for (const addition of custom) {
    const index = indexes.get(addition.type);
    if (index === undefined) {
      entries.push({
        type: addition.type,
        aliases: [...(addition.aliases ?? [])],
        globs: [...(addition.globs ?? [])],
        ...(addition.supertype === undefined
          ? {}
          : { supertype: addition.supertype }),
        rootXml: [...(addition.rootXml ?? [])],
        magic: [],
      });
      indexes.set(addition.type, entries.length - 1);
      continue;
    }
    if (addition.override === true) {
      entries[index] = {
        type: addition.type,
        aliases: [...(addition.aliases ?? [])],
        globs: [...(addition.globs ?? [])],
        ...(addition.supertype === undefined
          ? {}
          : { supertype: addition.supertype }),
        rootXml: [...(addition.rootXml ?? [])],
        magic: [],
      };
      continue;
    }
    const existing = entries[index]!;
    const supertype = addition.supertype ?? existing.supertype;
    entries[index] = {
      ...existing,
      aliases: [...new Set([...existing.aliases, ...(addition.aliases ?? [])])],
      globs: [...new Set([...existing.globs, ...(addition.globs ?? [])])],
      rootXml: [...existing.rootXml, ...(addition.rootXml ?? [])],
      ...(supertype === undefined ? {} : { supertype }),
    };
  }
  return entries;
}
