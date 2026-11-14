import {
  MediaType,
  compileSafeRegex,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { SaxesParser } from "saxes";

export interface RegexCaptureParserOptions {
  /** Metadata key to capture group 1 of the pattern, applied line by line (Tika captureMap). */
  readonly captureMap?: Readonly<Record<string, string>>;
  /** Metadata key set to "true" when the pattern matches a line (Tika matchMap). */
  readonly matchMap?: Readonly<Record<string, string>>;
  /** Write each line through to the content handler (Tika writeContent). */
  readonly writeContent?: boolean;
}

/**
 * Tika's RegexCaptureParser, an opt-in text/plain parser: operator-supplied regexes capture metadata from the lines.
 * It is not in the default registry; pass an instance in a custom parser list. Patterns go through
 * `compileSafeRegex`, so a hostile configuration cannot install a catastrophic pattern.
 */
export class RegexCaptureParser implements Parser {
  readonly name = "RegexCaptureParser";
  readonly #capture: ReadonlyArray<readonly [string, RegExp]>;
  readonly #match: ReadonlyArray<readonly [string, RegExp]>;
  readonly #writeContent: boolean;

  constructor(options: RegexCaptureParserOptions = {}) {
    this.#capture = Object.entries(options.captureMap ?? {}).map(([key, pattern]) => [key, compileSafeRegex(pattern)]);
    this.#match = Object.entries(options.matchMap ?? {}).map(([key, pattern]) => [key, compileSafeRegex(pattern)]);
    this.#writeContent = options.writeContent ?? false;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.TEXT_PLAIN]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: false });
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
    const captured = new Map<string, Set<string>>();
    for (const line of text.split(/\r?\n/)) {
      for (const [key, pattern] of this.#capture) {
        const match = pattern.exec(line);
        if (match !== null && match[1] !== undefined) {
          let values = captured.get(key);
          if (values === undefined) captured.set(key, (values = new Set()));
          values.add(match[1]);
        }
      }
      for (const [key, pattern] of this.#match) {
        if (pattern.test(line)) metadata.set(key, "true");
      }
      if (this.#writeContent) await handler.characters?.(line, 0, line.length);
    }
    for (const [key, values] of captured) for (const value of values) metadata.add(key, value);
  }
}

/**
 * Tika's XMLProfiler, an opt-in XML parser: the root entity and the namespace/local-name profile, as
 * `xmlprofiler:root-entity`, `xmlprofiler:entity-uris` and `xmlprofiler:entity-local-names` (a parallel array,
 * each entry the sorted local names for that namespace).
 */
export class XMLProfiler implements Parser {
  readonly name = "XMLProfiler";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([
      MediaType.parse("application/xml")!,
      MediaType.parse("application/rdf+xml")!,
      MediaType.parse("application/vnd.adobe.xdp+xml")!,
    ]);
  }

  async parse(
    stream: RipstreamInputStream,
    _handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: false });
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();

    const entities = new Map<string, Set<string>>();
    let root: string | null = null;
    const parser = new SaxesParser({ xmlns: true });
    parser.on("opentag", (tag) => {
      if (root === null) root = tag.name;
      let names = entities.get(tag.uri);
      if (names === undefined) entities.set(tag.uri, (names = new Set()));
      names.add(tag.local);
    });
    parser.write(text).close();

    if (root !== null) metadata.set("xmlprofiler:root-entity", root);
    for (const [uri, names] of [...entities].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      metadata.add("xmlprofiler:entity-uris", uri);
      metadata.add("xmlprofiler:entity-local-names", [...names].sort().join(" "));
    }
  }
}
