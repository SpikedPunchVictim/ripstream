import { entryParts } from "./component-config.ts";
import { UPSTREAM_COMPONENTS } from "./generated/upstream-services.ts";
import { MediaType } from "./media-type.ts";
import type { RipstreamConfig } from "./config.ts";
import { TIKA_KEYS } from "./tika-keys.ts";
import type { LanguageIdentifier } from "./language.ts";
import { LANGUAGE_MAX_LENGTH_RANGE, LanguageDetectionMetadataFilter } from "./language-metadata-filter.ts";
import {
  CaptureGroupMetadataFilter,
  ClearByAttachmentTypeMetadataFilter,
  CompositeMetadataFilter,
  DateNormalizingMetadataFilter,
  ExcludeFieldMetadataFilter,
  FieldNameMappingFilter,
  GeoPointMetadataFilter,
  IncludeFieldMetadataFilter,
  NoOpFilter,
  RemoveByMimeMetadataFilter,
  type MetadataFilter,
} from "./metadata-filter.ts";
import { LegacyKeyMigrationFilter } from "./legacy-key-migration-filter.ts";

/*
 * The `metadata-filters` section of a Tika configuration (tika-core 4.2.0, TikaLoader's `metadata-filters` component):
 * an array whose elements are a filter's name or an object keyed by it, run in order. There is no default filter, so no
 * section or an empty one runs nothing.
 *
 * Tika deserializes a filter's settings with Jackson, which fails on a setting the filter has not. Ripstream does the
 * same, and is stricter about a value's type (a number is not a list of names, "false" is not false) and about the
 * spelling of a name (CFG-075: the case-insensitive enums Jackson accepts are not read), so a misspelt setting is
 * reported where Tika might have read it as something else. A setting that could not do anything is reported too: a
 * `mimes` entry that is not a base type in lower case never matches in Tika and says nothing.
 *
 * A filter ripstream has no counterpart of is refused by name with the reason, never accepted and left out.
 */

/** One element of a `metadata-filters` section, read: the filter's Tika name and the settings it has been given. */
export interface MetadataFilterEntry {
  readonly name: string;
  /** Only the settings the entry gave: the filter's defaults are its own. Frozen. */
  readonly settings: Readonly<Record<string, unknown>>;
}

type Settings = Readonly<Record<string, unknown>>;

/**
 * What a filter needs that core does not have, handed in by whoever builds the chain (the CLI and the server give the
 * detector `@spikedpunch/ripstream-language` ships). A filter whose service is missing is refused when the chain is built.
 */
export interface MetadataFilterServices {
  /** What `charsoup-metadata-filter` runs to find a document's language. */
  readonly languageIdentifier?: LanguageIdentifier;
}

type SettingKind =
  | "string"
  | "boolean"
  | "string-list"
  | "string-map"
  | { readonly oneOf: readonly string[] }
  | { readonly integer: { readonly min: number; readonly max: number } };

interface FilterSpec {
  /** The settings it reads, in the order they are checked. */
  readonly settings: Readonly<Record<string, SettingKind>>;
  readonly required?: readonly string[];
  /** What the settings must satisfy that their types do not say. Reports at `where`; runs only when the types are right. */
  readonly check?: (settings: Settings, where: string, issues: string[]) => void;
  readonly build: (settings: Settings, services: MetadataFilterServices) => MetadataFilter;
}

/**
 * The services a configuration is validated with. Validation builds each filter to find what it refuses, and never runs
 * one, so a service is never asked for anything; it is only there to be given.
 */
const VALIDATION_SERVICES: MetadataFilterServices = {
  languageIdentifier: {
    identify() {
      throw new Error("a language identifier is not run while a configuration is validated");
    },
  },
};

function languageIdentifierOf(name: string, services: MetadataFilterServices): LanguageIdentifier {
  if (services.languageIdentifier === undefined) {
    throw new Error(`${JSON.stringify(name)} needs a language identifier: build the chain with services.languageIdentifier`);
  }
  return services.languageIdentifier;
}

/** Tika's name for the table `legacy-key-migration-filter` reads, a classpath resource. */
const DEFAULT_MIGRATION_TABLE = "/org/apache/tika/metadata/metadata-migration-3x-4x.json";

const strings = (value: unknown): readonly string[] => (value as readonly string[] | undefined) ?? [];

/** A conditional spread for a setting that may be absent, so an absent one is not passed as `undefined`. */
function given<Key extends string, Value>(key: Key, value: Value | undefined): { [Name in Key]?: Value } {
  return (value === undefined ? {} : { [key]: value }) as { [Name in Key]?: Value };
}

function checkMimes(settings: Settings, where: string, issues: string[]): void {
  strings(settings.mimes).forEach((mime, index) => {
    const label = `${where}: setting "mimes"[${index}] ${JSON.stringify(mime)}`;
    const parsed = MediaType.parse(mime);
    if (parsed === null) {
      issues.push(`${label} is not a media type`);
      return;
    }
    const base = parsed.getBaseType().toString();
    if (base !== mime) {
      issues.push(`${label} can never match: the filter compares the base type, in lower case and with no parameters (${JSON.stringify(base)})`);
    }
  });
}

function checkMigrationTable(settings: Settings, where: string, issues: string[]): void {
  if (settings.table === undefined || settings.table === DEFAULT_MIGRATION_TABLE) return;
  issues.push(
    `${where}: setting "table" names a classpath resource; ripstream ships Tika's table and has no classpath, so only Tika's own, ${JSON.stringify(DEFAULT_MIGRATION_TABLE)}, is accepted`,
  );
}

const SPECS: ReadonlyMap<string, FilterSpec> = new Map<string, FilterSpec>([
  [
    "include-field-metadata-filter",
    { settings: { include: "string-list" }, build: (s) => new IncludeFieldMetadataFilter({ include: strings(s.include) }) },
  ],
  [
    "exclude-field-metadata-filter",
    { settings: { exclude: "string-list" }, build: (s) => new ExcludeFieldMetadataFilter({ exclude: strings(s.exclude) }) },
  ],
  [
    "field-name-mapping-filter",
    {
      settings: { mappings: "string-map", excludeUnmapped: "boolean" },
      build: (s) =>
        new FieldNameMappingFilter({
          mappings: (s.mappings as Readonly<Record<string, string>> | undefined) ?? {},
          ...given("excludeUnmapped", s.excludeUnmapped as boolean | undefined),
        }),
    },
  ],
  [
    "remove-by-mime-metadata-filter",
    {
      settings: { mimes: "string-list" },
      check: checkMimes,
      build: (s) => new RemoveByMimeMetadataFilter({ mimes: strings(s.mimes) }),
    },
  ],
  [
    "clear-by-attachment-type-metadata-filter",
    {
      settings: { types: "string-list" },
      build: (s) => new ClearByAttachmentTypeMetadataFilter({ types: strings(s.types) }),
    },
  ],
  [
    "date-normalizing-metadata-filter",
    {
      settings: { defaultTimeZone: "string" },
      build: (s) => new DateNormalizingMetadataFilter(given("defaultTimeZone", s.defaultTimeZone as string | undefined)),
    },
  ],
  [
    "capture-group-metadata-filter",
    {
      settings: { regex: "string", sourceField: "string", targetField: "string" },
      required: ["regex", "sourceField", "targetField"],
      build: (s) =>
        new CaptureGroupMetadataFilter({
          regex: s.regex as string,
          sourceField: s.sourceField as string,
          targetField: s.targetField as string,
        }),
    },
  ],
  [
    "geo-point-metadata-filter",
    {
      settings: { geoPointFieldName: "string" },
      build: (s) => new GeoPointMetadataFilter(given("geoPointFieldName", s.geoPointFieldName as string | undefined)),
    },
  ],
  [
    "legacy-key-migration-filter",
    {
      settings: { direction: { oneOf: ["V4_TO_V3", "V3_TO_V4"] }, table: "string" },
      check: checkMigrationTable,
      build: (s) => new LegacyKeyMigrationFilter(given("direction", s.direction as "V4_TO_V3" | "V3_TO_V4" | undefined)),
    },
  ],
  [
    "charsoup-metadata-filter",
    {
      settings: { maxLength: { integer: LANGUAGE_MAX_LENGTH_RANGE } },
      build: (s, services) =>
        new LanguageDetectionMetadataFilter({
          identifier: languageIdentifierOf("charsoup-metadata-filter", services),
          ...given("maxLength", s.maxLength as number | undefined),
        }),
    },
  ],
  ["no-op-filter", { settings: {}, build: () => new NoOpFilter() }],
]);

/** Filters Tika has under `metadata-filters` and ripstream does not, each with why. */
const UNAVAILABLE: ReadonlyMap<string, string> = new Map([
  ["optimaize-metadata-filter", "ripstream has no Optimaize language detector"],
  ["open-nlp-metadata-filter", "ripstream has no OpenNLP language detector"],
  ["tika-eval-metadata-filter", "ripstream has no tika-eval"],
]);

const KIND_OF: ReadonlyMap<string, string> = new Map(UPSTREAM_COMPONENTS.map((component) => [component.name, component.kind]));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function oneOfText(values: readonly string[]): string {
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/**
 * A copy of the value of one setting, read once. When it is not what the kind says, why is reported and what comes back
 * is not to be used: the caller stops at the first issue.
 */
function readSetting(kind: SettingKind, key: string, value: unknown, where: string, issues: string[]): unknown {
  const label = `${where}: setting ${JSON.stringify(key)}`;
  if (kind === "string") {
    if (typeof value === "string") return value;
    issues.push(`${label} must be a string`);
  } else if (kind === "boolean") {
    if (typeof value === "boolean") return value;
    issues.push(`${label} must be true or false`);
  } else if (kind === "string-list") {
    if (!Array.isArray(value)) {
      issues.push(`${label} must be an array of strings`);
      return undefined;
    }
    const items: unknown[] = Array.from(value);
    items.forEach((item, index) => {
      if (typeof item !== "string") issues.push(`${label}[${index}] must be a string`);
    });
    return items;
  } else if (kind === "string-map") {
    if (!isObject(value)) {
      issues.push(`${label} must be an object of field names to field names`);
      return undefined;
    }
    const pairs = Object.entries(value);
    for (const [from, to] of pairs) {
      if (typeof to !== "string") issues.push(`${label} ${JSON.stringify(from)} must be a field name (a string)`);
    }
    return Object.fromEntries(pairs);
  } else if ("integer" in kind) {
    const { min, max } = kind.integer;
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
    issues.push(`${label} must be a whole number from ${min} to ${max}`);
  } else {
    if (typeof value === "string" && kind.oneOf.includes(value)) return value;
    issues.push(`${label} must be ${oneOfText(kind.oneOf)}`);
  }
  return undefined;
}

/** The settings an entry gave, copied and checked, or null after reporting what is wrong with them. */
function readSettings(name: string, spec: FilterSpec, provided: Record<string, unknown>, where: string, issues: string[]): Settings | null {
  const before = issues.length;
  const read = Object.entries(provided);
  const allowed = Object.keys(spec.settings);
  for (const [key] of read) {
    if (allowed.includes(key)) continue;
    const reads = allowed.length === 0 ? `${name} takes no settings` : `${name} reads: ${allowed.join(", ")}`;
    issues.push(`${where}: setting ${JSON.stringify(key)} is not supported (${reads})`);
  }
  const chosen: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(spec.settings)) {
    const found = read.find(([candidate]) => candidate === key);
    if (found === undefined) {
      if (spec.required?.includes(key) === true) issues.push(`${where}: setting ${JSON.stringify(key)} is required`);
      continue;
    }
    const value = readSetting(kind, key, found[1], where, issues);
    if (value !== undefined) chosen[key] = value;
  }
  // Nothing else is checked of settings that are the wrong type: the checks and the filter take them to be right.
  if (issues.length > before) return null;
  spec.check?.(chosen, where, issues);
  // What the filter itself refuses (a regex with no group, a zone that is not one, a type that is not an attachment type)
  // is found now, not at the first document.
  try {
    spec.build(chosen, VALIDATION_SERVICES);
  } catch (error) {
    issues.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return issues.length > before ? null : chosen;
}

function unknownFilter(position: string, name: string): string {
  const kind = KIND_OF.get(name);
  if (kind !== undefined) {
    return `${position}: ${JSON.stringify(name)} is not a metadata filter: it is listed under ${kind}`;
  }
  return `${position}: unknown metadata filter ${JSON.stringify(name)} (the filters are ${[...SPECS.keys()].sort().join(", ")})`;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Entries as frozen copies, so that nothing that holds them can change what a chain built from them does. Hand-built entries too. */
export function freezeMetadataFilterEntries(entries: readonly MetadataFilterEntry[]): readonly MetadataFilterEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ name: entry.name, settings: deepFreeze(structuredClone(entry.settings)) })));
}

/**
 * Reads a `metadata-filters` array (the top-level section, or the one in `parse-context`; `section` is how a message
 * names it) into entries, and reports everything Tika would accept and ripstream cannot honor, and everything that
 * is wrong. The entries are those that are right, so they are to be used only when there is no issue. It reads each value
 * of the caller's object once and returns copies; `RipstreamConfig` freezes them.
 */
export function parseMetadataFilterSection(
  section: string,
  value: unknown,
): { entries: readonly MetadataFilterEntry[]; issues: string[] } {
  const issues: string[] = [];
  if (!Array.isArray(value)) return { entries: [], issues: [`${section} must be an array`] };

  const entries: MetadataFilterEntry[] = [];
  value.forEach((raw: unknown, index) => {
    const position = `${section}[${index}]`;
    const parts = entryParts(raw, position, issues);
    if (parts === null) return;
    const [name, settings] = parts;
    const unavailable = UNAVAILABLE.get(name);
    if (unavailable !== undefined) {
      issues.push(`${position}: ${JSON.stringify(name)} is not supported: ${unavailable}`);
      return;
    }
    const spec = SPECS.get(name);
    if (spec === undefined) {
      issues.push(unknownFilter(position, name));
      return;
    }
    const chosen = readSettings(name, spec, settings, `${position} ${JSON.stringify(name)}`, issues);
    if (chosen !== null) entries.push({ name, settings: chosen });
  });
  return { entries, issues };
}

/**
 * The chain a `metadata-filters` section names: its filters in order, each on what the one before left. An empty list is
 * Tika's no-op filter.
 */
export function createMetadataFilter(entries: readonly MetadataFilterEntry[], services: MetadataFilterServices = {}): MetadataFilter {
  if (entries.length === 0) return new NoOpFilter();
  return new CompositeMetadataFilter(
    entries.map((entry) => {
      const spec = SPECS.get(entry.name);
      if (spec === undefined) throw new RangeError(`${JSON.stringify(entry.name)} is not a metadata filter ripstream has`);
      return spec.build(entry.settings, services);
    }),
  );
}

/**
 * The filters an emit has to choose from. `configured` is the top-level `metadata-filters` chain; `parseContext` is the
 * chain of the `parse-context` section, which Tika puts in the parse context and which therefore comes first.
 */
export interface EmitMetadataFilters {
  readonly configured?: MetadataFilter | null;
  readonly parseContext?: MetadataFilter | null;
}

/** What Tika's CONTENT_ONLY emit keeps when the parse context has no filter of its own. */
const CONTENT_ONLY_FILTER = new IncludeFieldMetadataFilter({ include: [TIKA_KEYS.CONTENT, TIKA_KEYS.CONTAINER_EXCEPTION] });

/**
 * The filter an emit runs, or null when it runs none (Tika's `EmitHandler.filterMetadata`). A filter in the parse context
 * is the one; else CONTENT_ONLY keeps the content and the container exception, whatever is configured; else the
 * configured chain. A chain that is Tika's no-op filter is none, wherever it is.
 */
export function emitMetadataFilter(filters: EmitMetadataFilters | undefined, contentOnly: boolean): MetadataFilter | null {
  const chosen = filters?.parseContext ?? (contentOnly ? CONTENT_ONLY_FILTER : filters?.configured) ?? null;
  return chosen === null || chosen instanceof NoOpFilter ? null : chosen;
}

/** The filters of a configuration, built. An absent section is none; the filters run on documents one at a time and hold nothing between them. */
export function metadataFiltersOf(
  config: Pick<RipstreamConfig, "metadataFilters" | "parseContextMetadataFilters">,
  services: MetadataFilterServices = {},
): EmitMetadataFilters {
  return {
    configured: config.metadataFilters === null ? null : createMetadataFilter(config.metadataFilters, services),
    parseContext: config.parseContextMetadataFilters === null ? null : createMetadataFilter(config.parseContextMetadataFilters, services),
  };
}
