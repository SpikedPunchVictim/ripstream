import {
  MediaType,
  Metadata,
  type InputSource,
  type MediaTypeResult,
  type ParseOptions,
  type ParseRecord,
  type ParseResult,
  type Ripstream,
} from "@spikedpunch/ripstream-core";

/**
 * A scripted stand-in for the core Ripstream, with spies. isolation-node never depends on the real parsers, so
 * the tests decide what "detection" says and can prove which instance parsed what.
 */

export type FakeRipstream = Pick<Ripstream, "detect" | "parse" | "parseRecursive"> & {
  readonly detectCalls: Array<{
    readonly source: InputSource | null;
    readonly filename: string | undefined;
    readonly signal: AbortSignal | undefined;
  }>;
  readonly parseCalls: Array<{ readonly source: InputSource; readonly options: ParseOptions }>;
  readonly parseRecursiveCalls: Array<{ readonly source: InputSource; readonly options: ParseOptions }>;
  /** parse + parseRecursive calls. */
  parseCount(): number;
};

export interface FakeRipstreamOptions {
  /** The media type detection answers with. Default application/zip (never allowlisted). */
  readonly type?: string;
  /** Replaces detection entirely (to throw, hang, or look at the source). */
  readonly detect?: (source: InputSource | null, signal: AbortSignal | undefined) => Promise<MediaTypeResult>;
  /** Replaces parse (to wait for the signal, throw, ...). */
  readonly parse?: (source: InputSource, options: ParseOptions) => Promise<ParseResult>;
  readonly parseRecursive?: (source: InputSource, options: ParseOptions) => Promise<readonly ParseRecord[]>;
}

export const IN_PROCESS_TEXT = "parsed in process";

export function fakeRipstream(options: FakeRipstreamOptions = {}): FakeRipstream {
  const type = MediaType.parseOrThrow(options.type ?? "application/zip");
  const fake: FakeRipstream = {
    detectCalls: [],
    parseCalls: [],
    parseRecursiveCalls: [],
    parseCount: () => fake.parseCalls.length + fake.parseRecursiveCalls.length,
    async detect(source, detectOptions = {}) {
      fake.detectCalls.push({ source, filename: detectOptions.filename, signal: detectOptions.signal });
      return options.detect === undefined ? type : options.detect(source, detectOptions.signal);
    },
    async parse(source, parseOptions = {}) {
      fake.parseCalls.push({ source, options: parseOptions });
      if (options.parse !== undefined) return options.parse(source, parseOptions);
      return { metadata: new Metadata({ "Content-Type": "text/plain" }), text: IN_PROCESS_TEXT };
    },
    async parseRecursive(source, parseOptions = {}) {
      fake.parseRecursiveCalls.push({ source, options: parseOptions });
      if (options.parseRecursive !== undefined) return options.parseRecursive(source, parseOptions);
      return [
        {
          metadata: new Metadata({ "Content-Type": "text/plain" }),
          content: IN_PROCESS_TEXT,
          embeddedResourcePath: "/doc",
          depth: 0,
          mediaType: MediaType.TEXT_PLAIN,
          exception: null,
        },
      ];
    },
  };
  return fake;
}
