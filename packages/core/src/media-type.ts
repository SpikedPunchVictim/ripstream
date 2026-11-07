const VALID_CHARS = String.raw`[^\s()<>@,;:\\"/\[\]?=]+`;
const TYPE_PATTERN = new RegExp(
  String.raw`^\s*(${VALID_CHARS})\s*/\s*(${VALID_CHARS})\s*($|;.*)$`,
  "s",
);
const CHARSET_FIRST_PATTERN = new RegExp(
  String.raw`^\s*(charset\s*=\s*[^;\s]+)\s*;\s*(${VALID_CHARS})\s*/\s*(${VALID_CHARS})\s*$`,
  "is",
);
const SPECIAL = /[()<>@,;:\\"/\[\]?=]/g;
const SPECIAL_OR_WHITESPACE = /[()<>@,;:\\"/\[\]?=\s]/;
const SIMPLE_NAME = /^[a-z0-9+._-]+$/;
const SIMPLE_TYPES = new Map<string, MediaType>();
const SIMPLE_TYPES_LIMIT = 10_000;

function isSimpleName(value: string): boolean {
  return value.length > 0 && SIMPLE_NAME.test(value);
}

function unquote(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '"' || value[start] === "'")) start++;
  while (end > start && (value[end - 1] === '"' || value[end - 1] === "'")) end--;
  return value.slice(start, end);
}

function parseParameters(source: string): Map<string, string> {
  const parameters = new Map<string, string>();
  if (source.length === 0) return parameters;

  for (const segment of source.split(";")) {
    const equals = segment.indexOf("=");
    const key = (equals === -1 ? segment : segment.slice(0, equals)).trim();
    if (key.length === 0) continue;
    const value = equals === -1 ? "" : unquote(segment.slice(equals + 1).trim());
    parameters.set(key, value);
  }

  return parameters;
}

function quoteValue(value: string): string {
  if (!SPECIAL_OR_WHITESPACE.test(value)) return value;
  return `"${value.replace(SPECIAL, "\\$&")}"`;
}

/**
 * Port of org.apache.tika.mime.MediaType.
 *
 * Canonical form: lowercased type/subtype, parameter keys trimmed and
 * lowercased, parameters sorted by key, values unchanged but quoted when they
 * contain separators or whitespace. Equality is canonical-string equality,
 * matching upstream.
 */
export class MediaType implements Comparable<MediaType> {
  static readonly OCTET_STREAM = MediaType.parse("application/octet-stream")!;
  static readonly EMPTY = MediaType.parse("application/x-empty")!;
  static readonly TEXT_PLAIN = MediaType.parse("text/plain")!;
  static readonly TEXT_HTML = MediaType.parse("text/html")!;
  static readonly APPLICATION_XML = MediaType.parse("application/xml")!;
  static readonly APPLICATION_ZIP = MediaType.parse("application/zip")!;

  readonly type: string;
  readonly subtype: string;
  readonly parameters: ReadonlyMap<string, string>;
  private readonly canonical: string;

  constructor(
    type: string,
    subtype: string,
    parameters: ReadonlyMap<string, string> | Record<string, string> = new Map(),
  ) {
    this.type = type.trim().toLowerCase();
    this.subtype = subtype.trim().toLowerCase();

    const normalized = new Map<string, string>();
    const entries =
      parameters instanceof Map
        ? [...parameters.entries()]
        : Object.entries(parameters);
    for (const [key, value] of entries) {
      normalized.set(key.trim().toLowerCase(), value);
    }

    const sorted = [...normalized.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    this.parameters = new Map(sorted);

    let canonical = `${this.type}/${this.subtype}`;
    for (const [key, value] of sorted) {
      canonical += `; ${key}=${quoteValue(value)}`;
    }
    this.canonical = canonical;
  }

  /**
   * Upstream returns null for null, malformed, and slash-less input.
   */
  static parse(value: string | null | undefined): MediaType | null {
    if (value == null) return null;

    const cached = SIMPLE_TYPES.get(value);
    if (cached !== undefined) return cached;

    const slash = value.indexOf("/");
    if (slash === -1) return null;

    const type = value.slice(0, slash);
    const subtype = value.slice(slash + 1);
    if (
      SIMPLE_TYPES.size < SIMPLE_TYPES_LIMIT &&
      isSimpleName(type) &&
      isSimpleName(subtype)
    ) {
      const simple = new MediaType(type, subtype);
      SIMPLE_TYPES.set(value, simple);
      return simple;
    }

    const match = TYPE_PATTERN.exec(value);
    if (match !== null) {
      return new MediaType(match[1]!, match[2]!, parseParameters(match[3] ?? ""));
    }

    const charsetFirst = CHARSET_FIRST_PATTERN.exec(value);
    if (charsetFirst !== null) {
      return new MediaType(
        charsetFirst[2]!,
        charsetFirst[3]!,
        parseParameters(charsetFirst[1]!),
      );
    }

    return null;
  }

  static parseOrThrow(value: string): MediaType {
    const parsed = MediaType.parse(value);
    if (parsed === null) throw new TypeError(`Invalid media type: ${value}`);
    return parsed;
  }

  static application(subtype: string): MediaType {
    return new MediaType("application", subtype);
  }

  static audio(subtype: string): MediaType {
    return new MediaType("audio", subtype);
  }

  static image(subtype: string): MediaType {
    return new MediaType("image", subtype);
  }

  static text(subtype: string): MediaType {
    return new MediaType("text", subtype);
  }

  static video(subtype: string): MediaType {
    return new MediaType("video", subtype);
  }

  get hasParameters(): boolean {
    return this.parameters.size > 0;
  }

  get charset(): string | null {
    return this.parameters.get("charset") ?? null;
  }

  getParameter(name: string): string | null {
    return this.parameters.get(name.trim().toLowerCase()) ?? null;
  }

  getBaseType(): MediaType {
    return this.hasParameters
      ? (MediaType.parse(`${this.type}/${this.subtype}`) ?? this)
      : this;
  }

  withParameters(
    parameters: ReadonlyMap<string, string> | Record<string, string>,
  ): MediaType {
    const merged = new Map(this.parameters);
    const entries =
      parameters instanceof Map
        ? parameters.entries()
        : Object.entries(parameters);
    for (const [key, value] of entries) merged.set(key, value);
    return new MediaType(this.type, this.subtype, merged);
  }

  withoutParameters(...names: string[]): MediaType {
    const excluded = new Set(names.map((name) => name.trim().toLowerCase()));
    const kept = new Map<string, string>();
    for (const [key, value] of this.parameters) {
      if (!excluded.has(key)) kept.set(key, value);
    }
    return new MediaType(this.type, this.subtype, kept);
  }

  equals(other: MediaType): boolean {
    return other instanceof MediaType && this.canonical === other.canonical;
  }

  compareTo(other: MediaType): number {
    return this.canonical < other.canonical
      ? -1
      : this.canonical > other.canonical
        ? 1
        : 0;
  }

  toString(): string {
    return this.canonical;
  }
}

export interface Comparable<T> {
  compareTo(other: T): number;
}
