import { formatUtc } from "./civil-time.ts";
import { metadataKeyDefinition } from "./generated/metadata-schema.ts";
import { compileJavaRegex } from "./java-regex.ts";
import { MediaType } from "./media-type.ts";
import type { Metadata } from "./metadata.ts";
import type { ParseContext } from "./parse-context.ts";
import { parseTikaDate } from "./tika-dates.ts";
import { EMBEDDED_RESOURCE_TYPES, TIKA_KEYS } from "./tika-keys.ts";
import { parseZoneId, type Zone } from "./zone-id.ts";

/**
 * Rewrites the metadata of a parse after it is done and before it is emitted: the last chance to drop a field, rename
 * it, normalize it or add a derived one (Tika's `MetadataFilter`). It is given the whole list (the container's metadata
 * first, then each embedded document's) and changes it in place, so it may also remove a document from the list.
 * Ripstream has no reserved-key guard on `Metadata` writes, so there is no separate trusted write: a filter writes
 * `tk:` keys as it writes any other.
 */
export interface MetadataFilter {
  filter(metadataList: Metadata[], context: ParseContext): void;
}

/** A filter that needs one document at a time (Tika's `MetadataFilterBase`). */
export abstract class MetadataFilterBase implements MetadataFilter {
  filter(metadataList: Metadata[], _context: ParseContext): void {
    for (const metadata of metadataList) this.filterOne(metadata);
  }

  protected abstract filterOne(metadata: Metadata): void;
}

/** Runs its filters in order; each sees what the one before it produced (Tika's `CompositeMetadataFilter`). */
export class CompositeMetadataFilter implements MetadataFilter {
  readonly filters: readonly MetadataFilter[];

  constructor(filters: readonly MetadataFilter[]) {
    this.filters = [...filters];
  }

  filter(metadataList: Metadata[], context: ParseContext): void {
    for (const filter of this.filters) filter.filter(metadataList, context);
  }
}

/** Does nothing (Tika's `NoOpFilter`). */
export class NoOpFilter implements MetadataFilter {
  filter(_metadataList: Metadata[], _context: ParseContext): void {}
}

export interface IncludeFieldOptions {
  /** The names to keep, each matched exactly (case-sensitive, no wildcards). None: every name is dropped. */
  readonly include: readonly string[];
}

/** Keeps the named fields and drops every other (Tika's `IncludeFieldMetadataFilter`). */
export class IncludeFieldMetadataFilter extends MetadataFilterBase {
  readonly #include: ReadonlySet<string>;

  constructor(options: IncludeFieldOptions) {
    super();
    this.#include = new Set(options.include);
  }

  protected override filterOne(metadata: Metadata): void {
    for (const name of metadata.names()) if (!this.#include.has(name)) metadata.remove(name);
  }
}

export interface ExcludeFieldOptions {
  /** The names to drop, each matched exactly (case-sensitive, no wildcards). */
  readonly exclude: readonly string[];
}

/** Drops the named fields and keeps every other (Tika's `ExcludeFieldMetadataFilter`). */
export class ExcludeFieldMetadataFilter extends MetadataFilterBase {
  readonly #exclude: readonly string[];

  constructor(options: ExcludeFieldOptions) {
    super();
    this.#exclude = [...new Set(options.exclude)];
  }

  protected override filterOne(metadata: Metadata): void {
    for (const name of this.#exclude) metadata.remove(name);
  }
}

export interface FieldNameMappingOptions {
  /** Old name to new name. */
  readonly mappings: Readonly<Record<string, string>>;
  /** Drop the names that have no mapping. Default true, so the filter is an allow-list that renames as it filters. */
  readonly excludeUnmapped?: boolean;
}

/**
 * Renames fields (Tika's `FieldNameMappingFilter`). A name is handled in the order the document has it, as each name
 * Tika's filter reads is: a rename onto a name the document has appends to that name's values, and with `excludeUnmapped`
 * a name that is not mapped is dropped whether it was there first or came from a rename.
 */
export class FieldNameMappingFilter extends MetadataFilterBase {
  readonly #mappings: ReadonlyMap<string, string>;
  readonly #excludeUnmapped: boolean;

  constructor(options: FieldNameMappingOptions) {
    super();
    this.#mappings = new Map(Object.entries(options.mappings));
    this.#excludeUnmapped = options.excludeUnmapped ?? true;
  }

  protected override filterOne(metadata: Metadata): void {
    for (const name of metadata.names()) {
      const target = this.#mappings.get(name);
      if (target !== undefined) {
        const values = [...metadata.getAll(name)];
        metadata.remove(name);
        for (const value of values) metadata.add(target, value);
      } else if (this.#excludeUnmapped) {
        metadata.remove(name);
      }
    }
  }
}

export interface CaptureGroupOptions {
  /** A Java regular expression (see `compileJavaRegex`) with at least one capturing group. */
  readonly regex: string;
  readonly sourceField: string;
  readonly targetField: string;
}

/**
 * Runs `regex` against the first value of `sourceField` and writes the first group of the first match to `targetField`,
 * replacing every value it had (Tika's `CaptureGroupMetadataFilter`). No source value, a blank one, or no match: nothing
 * is written. Tika accepts a regex with no group and fails on the first document it matches; this refuses it up front.
 */
export class CaptureGroupMetadataFilter extends MetadataFilterBase {
  readonly #regex: RegExp;
  readonly #sourceField: string;
  readonly #targetField: string;

  constructor(options: CaptureGroupOptions) {
    super();
    if (isBlank(options.sourceField)) throw new RangeError("Must specify a 'sourceField'");
    if (isBlank(options.targetField)) throw new RangeError("Must specify a 'targetField'");
    if (typeof options.regex !== "string") throw new RangeError("Must specify a 'regex'");
    this.#regex = compileJavaRegex(options.regex);
    // An empty alternative matches "" with every group unmatched, so the length is the group count plus one.
    if (new RegExp(`${this.#regex.source}|`, this.#regex.flags).exec("")!.length < 2) {
      throw new RangeError(`the regex ${JSON.stringify(options.regex)} has no capture group, and the filter writes group 1`);
    }
    this.#sourceField = options.sourceField;
    this.#targetField = options.targetField;
  }

  protected override filterOne(metadata: Metadata): void {
    const value = metadata.get(this.#sourceField);
    if (value === null || isBlank(value)) return;
    const match = this.#regex.exec(value);
    if (match !== null) metadata.set(this.#targetField, match[1]);
  }
}

export interface ClearByAttachmentTypeOptions {
  /** Values of `tk:embedded-resource-type`; see `EMBEDDED_RESOURCE_TYPES`. Case-sensitive. */
  readonly types: readonly string[];
}

/**
 * Empties, but keeps, the metadata of a document whose `tk:embedded-resource-type` is one of `types` (Tika's
 * `ClearByAttachmentTypeMetadataFilter`).
 */
export class ClearByAttachmentTypeMetadataFilter extends MetadataFilterBase {
  readonly #types: ReadonlySet<string>;

  constructor(options: ClearByAttachmentTypeOptions) {
    super();
    for (const type of options.types) {
      if ((EMBEDDED_RESOURCE_TYPES as readonly string[]).includes(type)) continue;
      throw new RangeError(
        `${JSON.stringify(type)} is not an attachment type. The types are (case-sensitive): ${EMBEDDED_RESOURCE_TYPES.join(", ")}`,
      );
    }
    this.#types = new Set(options.types);
  }

  protected override filterOne(metadata: Metadata): void {
    const type = metadata.get(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE);
    if (type === null || !this.#types.has(type)) return;
    for (const name of metadata.names()) metadata.remove(name);
  }
}

export interface RemoveByMimeOptions {
  /** Base media types, with no parameters and in lower case, as `MediaType` writes them. */
  readonly mimes: readonly string[];
}

/**
 * Takes a document out of the list when the base type of its `Content-Type` is one of `mimes` (Tika's
 * `RemoveByMimeMetadataFilter`); a document with no `Content-Type`, or one that is not a media type, stays.
 */
export class RemoveByMimeMetadataFilter implements MetadataFilter {
  readonly #mimes: ReadonlySet<string>;

  constructor(options: RemoveByMimeOptions) {
    this.#mimes = new Set(options.mimes);
  }

  filter(metadataList: Metadata[], _context: ParseContext): void {
    let kept = 0;
    for (const metadata of metadataList) if (!this.#shouldRemove(metadata)) metadataList[kept++] = metadata;
    metadataList.length = kept;
  }

  #shouldRemove(metadata: Metadata): boolean {
    const mediaType = MediaType.parse(metadata.get("Content-Type"));
    return mediaType !== null && this.#mimes.has(mediaType.getBaseType().toString());
  }
}

export interface GeoPointOptions {
  /** The field the `latitude,longitude` is written to. Default "location". */
  readonly geoPointFieldName?: string;
}

/** Writes `geo:lat` and `geo:long` as `lat,long` to one field when both are there (Tika's `GeoPointMetadataFilter`). */
export class GeoPointMetadataFilter extends MetadataFilterBase {
  readonly #fieldName: string;

  constructor(options: GeoPointOptions = {}) {
    super();
    this.#fieldName = options.geoPointFieldName ?? "location";
  }

  protected override filterOne(metadata: Metadata): void {
    const latitude = metadata.get("geo:lat");
    if (latitude === null || latitude === "") return;
    const longitude = metadata.get("geo:long");
    if (longitude === null || longitude === "") return;
    metadata.set(this.#fieldName, `${latitude},${longitude}`);
  }
}

export interface DateNormalizingOptions {
  /** Zone for a value that has none (see `parseZoneId`). Default "UTC". */
  readonly defaultTimeZone?: string;
}

/**
 * Rewrites every value of every date field (a key the metadata schema types as a date) to `yyyy-MM-dd'T'HH:mm:ss'Z'` in
 * UTC, for end points that need a `Z` zone (Tika's `DateNormalizingMetadataFilter`). An explicit offset is honoured; a
 * value with no zone is read in `defaultTimeZone`, a date-only value as midday there. A partial date is invented, not
 * dropped: `2019` is 2019-01-01 at midday, `2019-06` is 2019-06-01 at midday. A value that is not a date is left as it is;
 * Tika also logs a warning for it, and the core package has no logger to do that with. The dates are read as
 * `parseTikaDate` reads them.
 */
export class DateNormalizingMetadataFilter extends MetadataFilterBase {
  readonly defaultTimeZone: string;
  readonly #zone: Zone;

  constructor(options: DateNormalizingOptions = {}) {
    super();
    const id = options.defaultTimeZone ?? "UTC";
    if (typeof id !== "string") throw new RangeError("'defaultTimeZone' must be a zone id such as \"UTC\" or \"America/New_York\"");
    this.#zone = parseZoneId(id);
    this.defaultTimeZone = id;
  }

  protected override filterOne(metadata: Metadata): void {
    for (const name of metadata.names()) {
      if (metadataKeyDefinition(name)?.valueType !== "DATE") continue;
      metadata.setAll(
        name,
        metadata.getAll(name).map((value) => this.#toUtc(value) ?? value),
      );
    }
  }

  #toUtc(value: string): string | null {
    const date = parseTikaDate(value);
    if (date === null) return null;
    // A zone-less value reads as UTC in `epochSeconds`: that is its wall clock, which the default zone then places.
    const local = date.epochSeconds;
    return formatUtc(date.hasZone ? local : local - this.#zone.offsetAtLocal(local));
  }
}

/** Java's `String.isBlank`: empty, or only what `Character.isWhitespace` accepts (not a no-break space). */
function isBlank(value: unknown): boolean {
  return typeof value !== "string" || /^[\t\n\v\f\r\u001c-\u001f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/.test(value);
}

export interface WriteLimitOptions {
  readonly maxValueChars?: number;
  readonly maxValues?: number;
}

/** Caps value length and number of values per key. */
export class MetadataWriteLimitFilter extends MetadataFilterBase {
  readonly #maxValueChars: number;
  readonly #maxValues: number;

  constructor(options: WriteLimitOptions = {}) {
    super();
    this.#maxValueChars = options.maxValueChars ?? 1_000_000;
    this.#maxValues = options.maxValues ?? 1_000;
  }

  protected override filterOne(metadata: Metadata): void {
    for (const name of metadata.names()) {
      const values = metadata.getAll(name).slice(0, this.#maxValues);
      metadata.setAll(
        name,
        values.map((value) => (value.length > this.#maxValueChars ? value.slice(0, this.#maxValueChars) : value)),
      );
    }
  }
}
