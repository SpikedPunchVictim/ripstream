import {
  MediaType,
  ParseContext,
  RipstreamConfigError,
  type ComponentEntry,
  type ContentHandler,
  type MaybePromise,
  type MediaTypeRegistry,
  type Metadata,
  type Parser,
  type ParserCapabilities,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { TIKA_PARSER_TYPES } from "./generated/tika-parser-types.ts";

/*
 * Applying a Tika `parsers` section to ripstream's parser list.
 *
 * Ripstream's parsers do not line up with Tika's one to one: ImageParser serves what Tika splits across eight parser
 * classes, XmlParser nine. A Tika parser cannot therefore be removed by removing a ripstream parser. What a Tika parser
 * stands for is the set of media types it claims (TIKA_PARSER_TYPES), so the section is applied to media types, as
 * Tika itself does for `_mime-include` / `_mime-exclude` (ParserDecorator.withMimeFilters): a ripstream parser keeps
 * the types that some enabled Tika parser claims, and is dropped when none is left.
 *
 * Semantics, from AbstractSpiComponentLoader and ParserLoader (tika-serialization 4.2.0):
 *   - no entries: the full default.
 *   - `default-parser`: every parser Tika loads by default, minus its `exclude` list and minus every parser that is
 *     also listed by name, narrowed by its own `_mime-include` / `_mime-exclude`.
 *   - a named entry: exactly that parser, narrowed by its filters.
 *   - no `default-parser`: only the named entries.
 */

/** A ripstream parser restricted to some of its media types. It reports the name and capabilities of the real one. */
class TypeFilteredParser implements Parser {
  readonly name: string;
  readonly capabilities?: ParserCapabilities;
  readonly #delegate: Parser;
  readonly #keep: (type: MediaType) => boolean;

  constructor(delegate: Parser, keep: (type: MediaType) => boolean) {
    this.name = delegate.name;
    // The hazard audit and parserCapabilities() read these: a restricted parser is as unsafe as the one it wraps.
    if (delegate.capabilities !== undefined) this.capabilities = delegate.capabilities;
    this.#delegate = delegate;
    this.#keep = keep;
  }

  getSupportedTypes(ctx: ParseContext): MaybePromise<ReadonlySet<MediaType>> {
    const narrow = (types: ReadonlySet<MediaType>): ReadonlySet<MediaType> => new Set([...types].filter(this.#keep));
    const types = this.#delegate.getSupportedTypes(ctx);
    return types instanceof Promise ? types.then(narrow) : narrow(types);
  }

  parse(stream: RipstreamInputStream, handler: ContentHandler, metadata: Metadata, ctx: ParseContext): Promise<void> {
    return this.#delegate.parse(stream, handler, metadata, ctx);
  }
}

/** Two spellings of one type (`application/x-gzip`, `application/gzip`) must compare equal, or an alias keeps a type alive. */
function canonicalKey(registry: MediaTypeRegistry, value: string): string {
  const type = MediaType.parse(value);
  if (type === null) throw new Error(`${JSON.stringify(value)} is not a media type`);
  return (registry.normalize(type) ?? type).getBaseType().toString();
}

/** What an entry's `_mime-include` / `_mime-exclude` let through, by canonical key. */
function filterOf(entry: ComponentEntry, canonical: (value: string) => string): (key: string) => boolean {
  const include = new Set(entry.mimeInclude.map(canonical));
  const exclude = new Set(entry.mimeExclude.map(canonical));
  return (key) => (include.size === 0 || include.has(key)) && !exclude.has(key);
}

/**
 * Narrows `parsers` by a `parsers` section (its entries as `loadConfig` read them): a parser keeps the media types that
 * some enabled Tika parser claims, and one left with none is dropped. It never adds a parser, so a restricted list stays
 * as restricted as it was. `registry` is the one the parsers' types are compared in (the detector's).
 */
export function applyParserConfig(
  parsers: readonly Parser[],
  entries: readonly ComponentEntry[],
  registry: MediaTypeRegistry,
): Parser[] {
  // An empty section is no section: Tika loads everything.
  if (entries.length === 0) return [...parsers];

  const canonical = (value: string): string => canonicalKey(registry, value);
  const keyOf = (type: MediaType): string => (registry.normalize(type) ?? type).getBaseType().toString();
  const tikaKeys = (name: string): Set<string> | undefined =>
    Object.hasOwn(TIKA_PARSER_TYPES, name) ? new Set((TIKA_PARSER_TYPES[name] as readonly string[]).map(canonical)) : undefined;

  const context = new ParseContext();
  const own = parsers.map((parser) => {
    const types = parser.getSupportedTypes(context);
    if (types instanceof Promise) {
      throw new RipstreamConfigError([`parser ${parser.name} reports its media types asynchronously; a parsers section cannot be applied to it`]);
    }
    return { parser, keys: new Set([...types].map(keyOf)) };
  });
  const served = new Set(own.flatMap(({ keys }) => [...keys]));

  const marker = entries.find((entry) => entry.marker);
  const listed = entries.filter((entry) => !entry.marker);
  const issues: string[] = [];
  const enabled = new Set<string>();

  for (const entry of listed) {
    const claimed = tikaKeys(entry.name);
    if (claimed === undefined) {
      issues.push(
        `parser "${entry.name}" cannot be applied: nothing records the media types it claims ` +
          "(only a parser that the standard Tika 4.2.0 server loads, and that claims types of its own, can be named)",
      );
    } else if (![...claimed].some((key) => served.has(key))) {
      issues.push(`parser "${entry.name}" is not implemented: ripstream has no parser for any media type it claims`);
    } else {
      const passes = filterOf(entry, canonical);
      for (const key of claimed) if (passes(key)) enabled.add(key);
    }
  }
  if (issues.length > 0) throw new RipstreamConfigError(issues);

  // Types no Tika parser claims are ripstream's own coverage (application/json, source code): they follow the marker,
  // and so do its catch-alls unless something in their range was turned off.
  let ownedByMarker = (_key: string): boolean => false;
  if (marker !== undefined) {
    const left = new Set([...marker.exclude, ...listed.map((entry) => entry.name)]);
    const passes = filterOf(marker, canonical);
    const claimedByTika = new Set<string>();
    for (const [name, types] of Object.entries(TIKA_PARSER_TYPES)) {
      for (const key of types.map(canonical)) {
        claimedByTika.add(key);
        if (!left.has(name) && passes(key)) enabled.add(key);
      }
    }
    const disabled = [...claimedByTika].filter((key) => !enabled.has(key));
    ownedByMarker = (key) => {
      if (claimedByTika.has(key) || !passes(key)) return false;
      // A catch-all (TextParser's text/*) would turn a type back on that was just turned off, so it goes once any
      // type in its range is off. In Tika the same fallback runs through the excluded parser, so nothing takes it.
      if (key === "*/*") return disabled.length === 0;
      if (key.endsWith("/*")) return !disabled.some((off) => off.startsWith(key.slice(0, -1)));
      return true;
    };
  }

  const result: Parser[] = [];
  for (const { parser, keys } of own) {
    const allowed = new Set([...keys].filter((key) => enabled.has(key) || ownedByMarker(key)));
    if (allowed.size === 0) continue;
    result.push(allowed.size === keys.size ? parser : new TypeFilteredParser(parser, (type) => allowed.has(keyOf(type))));
  }
  return result;
}
