import { UPSTREAM_COMPONENTS } from "./generated/upstream-services.ts";
import { MediaType } from "./media-type.ts";

/** The sections of a Tika configuration that list components by name. */
export type ComponentSection = "parsers" | "detectors";

/**
 * One entry of a `parsers` or `detectors` section, in one shape whether it was written as a name or as an object.
 * Only the marker (`default-parser`, `default-detector`) has an `exclude` list.
 */
export interface ComponentEntry {
  readonly name: string;
  /** True for `default-parser` / `default-detector`: every component Tika loads by default. */
  readonly marker: boolean;
  readonly exclude: readonly string[];
  readonly mimeInclude: readonly string[];
  readonly mimeExclude: readonly string[];
  /** Parser properties named as Tika names them (`PDFParserConfig.sortByPosition`); absent when the entry sets none. */
  readonly settings?: Readonly<Record<string, boolean>>;
}

const MARKERS: Readonly<Record<ComponentSection, string>> = {
  parsers: "default-parser",
  detectors: "default-detector",
};

const SINGULAR: Readonly<Record<ComponentSection, string>> = { parsers: "parser", detectors: "detector" };

const NAMES: Readonly<Record<ComponentSection, ReadonlySet<string>>> = {
  parsers: new Set(UPSTREAM_COMPONENTS.filter((component) => component.kind === "parsers").map((component) => component.name)),
  detectors: new Set(UPSTREAM_COMPONENTS.filter((component) => component.kind === "detectors").map((component) => component.name)),
};

const MIME_KEYS = ["_mime-include", "_mime-exclude"] as const;

/**
 * The properties of a Tika parser's own configuration that ripstream applies, by Tika's parser name. They are the
 * `PDFParserConfig` bean properties that `PdfParser` has an option for; every other property is refused by name.
 */
const PARSER_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  "pdf-parser": ["sortByPosition", "extractAnnotationText"],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A media type list: one type or an array of them, as Tika reads it. Every item must be a real type. */
function mediaTypeList(key: string, value: unknown, where: string, issues: string[]): string[] {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (value !== undefined && !Array.isArray(value) && typeof value !== "string") {
    issues.push(`${where}: ${key} must be a media type or an array of them`);
    return [];
  }
  const types: string[] = [];
  items.forEach((item: unknown, index) => {
    const label = Array.isArray(value) ? `${key}[${index}]` : key;
    if (typeof item !== "string") {
      issues.push(`${where}: ${label} must be a media type`);
      return;
    }
    const parsed = MediaType.parse(item);
    if (parsed === null) issues.push(`${where}: ${label} ${JSON.stringify(item)} is not a media type`);
    else if (parsed.type === "image" && parsed.subtype.startsWith("ocr-")) {
      issues.push(`${where}: ${label} ${JSON.stringify(item)} is a retired image/ocr-* pseudo-type; filter the real type`);
    } else types.push(item);
  });
  return types;
}

function excludeList(value: unknown, section: ComponentSection, where: string, issues: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${where}: exclude must be an array of ${SINGULAR[section]} names`);
    return [];
  }
  const names: string[] = [];
  value.forEach((item: unknown, index) => {
    if (typeof item !== "string") issues.push(`${where}: exclude[${index}] must be a ${SINGULAR[section]} name`);
    else if (item === MARKERS[section]) issues.push(`${where}: exclude[${index}] names the marker itself`);
    else if (!NAMES[section].has(item)) issues.push(`${where}: exclude names unknown ${SINGULAR[section]} ${JSON.stringify(item)}`);
    else names.push(item);
  });
  return names;
}

/**
 * The boolean settings of `keys` that the entry sets. Tika's loader coerces `"true"` or `1` into a boolean property;
 * ripstream refuses anything but true and false, so a misspelt value is not read as its opposite.
 */
function booleanSettings(
  keys: readonly string[],
  setting: (key: string) => unknown,
  where: string,
  issues: string[],
): Record<string, boolean> {
  const chosen: Record<string, boolean> = {};
  for (const key of keys) {
    const value = setting(key);
    if (value === undefined) continue;
    if (typeof value === "boolean") chosen[key] = value;
    else issues.push(`${where}: setting ${JSON.stringify(key)} must be true or false`);
  }
  return chosen;
}

/** The one `[name, settings]` pair of an entry, or null when it has been reported. */
export function entryParts(entry: unknown, position: string, issues: string[]): [string, Record<string, unknown>] | null {
  if (typeof entry === "string" && entry.length > 0) return [entry, {}];
  if (!isObject(entry)) {
    issues.push(`${position} must be a component name or an object`);
    return null;
  }
  const pairs = Object.entries(entry);
  if (pairs.length !== 1) {
    // Tika reads the first key and drops the others without a word.
    issues.push(`${position} has ${pairs.length} keys; an entry has exactly one`);
    return null;
  }
  const [name, settings] = pairs[0] as [string, unknown];
  if (!isObject(settings)) {
    issues.push(`${position} ${JSON.stringify(name)}: settings must be an object`);
    return null;
  }
  return [name, settings];
}

/**
 * Reads a `parsers` or `detectors` section in Tika's JSON shape into entries, and reports everything that Tika would
 * accept and ripstream cannot honor: a name that is not a registered component, a second key in an entry, an `exclude`
 * item that is not a name, and any setting other than `exclude` on the marker and, for parsers, the media type
 * filters and the few parser properties ripstream applies (`PARSER_SETTINGS`), which would otherwise be dropped
 * without a word.
 *
 * It reads each value of the caller's object once, and returns copies.
 */
export function parseComponentSection(
  section: ComponentSection,
  value: unknown,
): { entries: ComponentEntry[]; issues: string[] } {
  const issues: string[] = [];
  if (!Array.isArray(value)) return { entries: [], issues: [`${section} must be an array`] };

  const entries: ComponentEntry[] = [];
  let markers = 0;
  value.forEach((raw: unknown, index) => {
    const position = `${section}[${index}]`;
    const parts = entryParts(raw, position, issues);
    if (parts === null) return;
    const [name, settings] = parts;
    const marker = name === MARKERS[section];
    if (!marker && !NAMES[section].has(name)) {
      issues.push(`${position}: unknown ${SINGULAR[section]} ${JSON.stringify(name)}`);
      return;
    }
    if (marker && ++markers > 1) issues.push(`${section}: ${JSON.stringify(name)} appears more than once`);

    const where = `${position} ${JSON.stringify(name)}`;
    // Only a parser has media types to filter: Tika drops the filters on a named detector and refuses them on the marker.
    const filters: readonly string[] = section === "parsers" ? MIME_KEYS : [];
    const applied: readonly string[] = section === "parsers" && !marker ? (PARSER_SETTINGS[name] ?? []) : [];
    const allowed: readonly string[] = marker ? ["exclude", ...filters] : [...filters, ...applied];
    const read = Object.entries(settings);
    for (const [key] of read) {
      if (allowed.includes(key)) continue;
      const hint = applied.length === 0 ? "" : ` (ripstream applies ${applied.join(" and ")} of this parser)`;
      issues.push(`${where}: setting ${JSON.stringify(key)} is not supported${hint}`);
    }
    const setting = (key: string): unknown => read.find(([candidate]) => candidate === key)?.[1];
    const chosen = booleanSettings(applied, setting, where, issues);
    entries.push({
      name,
      marker,
      exclude: marker ? excludeList(setting("exclude"), section, where, issues) : [],
      mimeInclude: mediaTypeList("_mime-include", setting("_mime-include"), where, issues),
      mimeExclude: mediaTypeList("_mime-exclude", setting("_mime-exclude"), where, issues),
      ...(Object.keys(chosen).length === 0 ? {} : { settings: chosen }),
    });
  });
  return { entries, issues };
}
