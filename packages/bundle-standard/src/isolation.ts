import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createIsolatedRipstream,
  type IsolatedComponents,
  type IsolatedRipstream,
  type ParseLimits,
  type Parser,
  type Ripstream,
  type RipstreamConfig,
} from "@spikedpunch/ripstream-core";
import {
  createNodeIsolator,
  deriveLimits,
  type IsolatorRipstream,
  type NodeIsolator,
  type NodeIsolatorOptions,
} from "@spikedpunch/ripstream-isolation-node";
import { DefaultDetector } from "@spikedpunch/ripstream-mime";
import {
  CsvParser,
  HtmlDocumentParser,
  MarkdownParser,
  TextParser,
  XmlParser,
  applyParserConfig,
  createRipstream,
} from "@spikedpunch/ripstream-parsers";

/**
 * Absolute path of the standard isolation child entry, for `ChildRunnerOptions.childScript`.
 *
 * The entry sits next to this file and has this file's extension: `.ts` when running from source (tests, node
 * type stripping), `.js` from the built package.
 */
export function isolationChildPath(): string {
  const here = fileURLToPath(import.meta.url);
  return fileURLToPath(new URL(`./isolation-child${extname(here)}`, import.meta.url));
}

/**
 * The parsers behind `DEFAULT_IN_PROCESS_TYPES` (isolation-node, routing.ts), and nothing else:
 *   TextParser          text/plain, application/json, application/ld+json, application/manifest+json, text/x-yaml
 *   CsvParser           text/csv, text/tab-separated-values
 *   HtmlDocumentParser  text/html, application/xhtml+xml
 *   MarkdownParser      text/markdown
 *   XmlParser           text/xml, application/xml
 * The in-process ripstream detects again on the WHOLE input, so it must not own a container, image, audio, database
 * or PDF parser: a file whose prefix looks like text must never reach one inside the server process.
 */
export function createInProcessParsers(): Parser[] {
  return [new TextParser(), new CsvParser(), new HtmlDocumentParser(), new MarkdownParser(), new XmlParser()];
}

/**
 * A ripstream that can parse only what the isolation routing allowlist lets through. A configuration narrows it
 * further: the `parsers` section switches off what it names, and the `detectors` section shapes the type it detects
 * (the section never adds a parser, so the restriction holds).
 */
export function createInProcessRipstream(config?: RipstreamConfig): Ripstream {
  const detector = new DefaultDetector(config === undefined ? {} : { config });
  const section = config?.parsers ?? null;
  const parsers = section === null ? createInProcessParsers() : applyParserConfig(createInProcessParsers(), section, detector.getMediaTypeRegistry());
  return createRipstream({ parsers, detector });
}

export interface StandardIsolationOptions
  extends Omit<NodeIsolatorOptions, "ripstream" | "inProcessRipstream" | "childModule" | "components"> {
  /**
   * The configuration whose `parsers`, `detectors` and `parse-context` limits apply. The child, the routing detector,
   * `detect()` and the in-process parsers all build from its `parsers` and `detectors` sections, so they agree on what is
   * parsed; its limits become the defaults of every parse (see `limits`).
   */
  readonly ripstreamConfig?: RipstreamConfig;
  /**
   * Limits every parse starts from, laid over the configuration's; a limit a call names itself wins. Only what can
   * cross the boundary is accepted (maxOutputChars, maxEmbeddedResources, maxNodeDepth, maxParseMillis), and not
   * `maxOutputChars: -1`, since a child's memory is sized from the output cap.
   */
  readonly limits?: Partial<ParseLimits>;
}

export interface StandardIsolation {
  /** Owns the children and the memory pool it created; the caller disposes it. */
  readonly isolator: NodeIsolator;
  /** `parse` and `parseRecursive` go through the isolator; `detect` is answered in this process. */
  readonly ripstream: IsolatedRipstream;
}

/** The sections a child needs, or undefined when the configuration has neither (the child builds its defaults). */
function componentsOf(config: RipstreamConfig | undefined): IsolatedComponents | undefined {
  if (config === undefined || (config.parsers === null && config.detectors === null)) return undefined;
  return {
    ...(config.parsers === null ? {} : { parsers: config.parsers }),
    ...(config.detectors === null ? {} : { detectors: config.detectors }),
  };
}

/**
 * The standard composition of isolation: one full ripstream detects (routing, and `detect()` of the result), a
 * restricted one parses what stays in this process, and the standard child (`isolationChildPath()`) parses the rest.
 *
 * The restriction applies only while isolation is in force. When the mode in force is "off" (configured, or a
 * lenient isolator that found isolation unavailable and says so in its warning) nothing is ever spawned and every
 * document is parsed here; the restricted parsers would then make every binary format fail, so the full ripstream
 * parses instead. That adds no exposure: there is no boundary to protect.
 */
export async function createStandardIsolation(options: StandardIsolationOptions): Promise<StandardIsolation> {
  const { ripstreamConfig, limits: callerLimits, ...isolatorOptions } = options;
  const limits: Record<string, number> = {};
  for (const [name, value] of Object.entries({ ...ripstreamConfig?.limits, ...callerLimits })) {
    if (value !== undefined) limits[name] = value;
  }
  const defaults = limits as Partial<ParseLimits>;
  // What a request cannot carry is refused now, not at the first parse; so is a parse timer the isolation would refuse.
  const facade = (isolator: NodeIsolator, detector: Ripstream): IsolatedRipstream =>
    createIsolatedRipstream({ isolator, detector, limits: defaults });
  if (isolatorOptions.config.mode !== "off") {
    deriveLimits(isolatorOptions.config, {
      ...(defaults.maxOutputChars === undefined ? {} : { maxOutputChars: defaults.maxOutputChars }),
      ...(defaults.maxEmbeddedResources === undefined ? {} : { maxEmbeddedResources: defaults.maxEmbeddedResources }),
      ...(defaults.maxParseMillis === undefined ? {} : { maxParseMillis: defaults.maxParseMillis }),
    });
  }

  const full = createRipstream(ripstreamConfig === undefined ? {} : { config: ripstreamConfig });
  const restricted = createInProcessRipstream(ripstreamConfig);
  const components = componentsOf(ripstreamConfig);

  // Set before the first request can arrive; the isolator only reads this when a request is parsed in-process.
  let isolator: NodeIsolator | undefined;
  const inProcess = (): Ripstream => (isolator?.status().mode === "off" ? full : restricted);
  const inProcessRipstream: IsolatorRipstream = {
    detect: (source, detectOptions) => inProcess().detect(source, detectOptions),
    parse: (source, parseOptions) => inProcess().parse(source, parseOptions),
    parseRecursive: (source, parseOptions) => inProcess().parseRecursive(source, parseOptions),
  };

  isolator = await createNodeIsolator({
    ...isolatorOptions,
    // The default output cap sizes the pool and is checked now: a configured maxOutputChars no child could hold fails here.
    ...(isolatorOptions.defaultMaxOutputChars === undefined && defaults.maxOutputChars !== undefined && isolatorOptions.config.mode !== "off"
      ? { defaultMaxOutputChars: defaults.maxOutputChars }
      : {}),
    ripstream: full,
    inProcessRipstream,
    childModule: isolationChildPath(),
    ...(components === undefined ? {} : { components }),
  });
  try {
    return { isolator, ripstream: facade(isolator, full) };
  } catch (error) {
    await isolator.dispose();
    throw error;
  }
}
