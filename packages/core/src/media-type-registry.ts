import { MediaType } from "./media-type.ts";

/**
 * Port of org.apache.tika.mime.MediaTypeRegistry: canonical types, aliases,
 * and the single-step supertype walk used for specialization checks.
 */
export class MediaTypeRegistry {
  private readonly canonical = new Map<string, MediaType>();
  private readonly aliases = new Map<string, MediaType>();
  private readonly inheritance = new Map<string, MediaType>();

  addType(type: MediaType): void {
    const base = type.getBaseType();
    this.canonical.set(base.toString(), base);
  }

  addAlias(type: MediaType, alias: MediaType): void {
    this.aliases.set(alias.getBaseType().toString(), type.getBaseType());
  }

  /**
   * Keyed by the full type, parameters included, as upstream does: `x-rar-compressed;version=4` is a kind of
   * `x-rar-compressed`, and keying by the base type would make `x-rar-compressed` its own parent.
   */
  addSuperType(type: MediaType, parent: MediaType): void {
    this.inheritance.set(type.toString(), parent.getBaseType());
  }

  normalize(type: MediaType | null): MediaType | null {
    if (type === null) return null;

    const base = type.getBaseType();
    const registered =
      this.canonical.get(base.toString()) ?? this.aliases.get(base.toString());
    if (registered === undefined) return type;
    return type.hasParameters
      ? registered.withParameters(type.parameters)
      : registered;
  }

  /**
   * One step only, in upstream order. Returns null for octet-stream.
   */
  getSupertype(type: MediaType | null): MediaType | null {
    if (type === null) return null;

    const configured = this.inheritance.get(type.toString());
    if (configured !== undefined) return configured;
    if (type.hasParameters) return type.getBaseType();
    if (type.subtype.endsWith("+xml")) return MediaType.APPLICATION_XML;
    if (type.subtype.endsWith("+zip")) return MediaType.APPLICATION_ZIP;
    if (type.type === "text" && !type.equals(MediaType.TEXT_PLAIN)) {
      return MediaType.TEXT_PLAIN;
    }
    if (type.type.includes("empty") && !type.equals(MediaType.EMPTY)) {
      return MediaType.EMPTY;
    }
    if (!type.equals(MediaType.OCTET_STREAM)) {
      return MediaType.OCTET_STREAM;
    }
    return null;
  }

  isSpecializationOf(type: MediaType, parent: MediaType): boolean {
    const visited = new Set<string>();
    let current: MediaType | null = type;
    while (current !== null) {
      const key = current.toString();
      if (visited.has(key)) return false;
      visited.add(key);
      current = this.getSupertype(current);
      if (current !== null && current.equals(parent)) return true;
    }
    return false;
  }

  isInstanceOf(type: MediaType | null, parent: MediaType): boolean {
    if (type === null) return false;
    return type.equals(parent) || this.isSpecializationOf(type, parent);
  }
}
