import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedRipstream, type IsolatedRipstream, type Parser, type Ripstream } from "@spikedpunch/ripstream-core";
import {
  createNodeIsolator,
  type IsolatorRipstream,
  type NodeIsolator,
  type NodeIsolatorOptions,
} from "@spikedpunch/ripstream-isolation-node";
import { CsvParser, HtmlDocumentParser, MarkdownParser, TextParser, XmlParser, createRipstream } from "@spikedpunch/ripstream-parsers";

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

/** A ripstream that can parse only what the isolation routing allowlist lets through. */
export function createInProcessRipstream(): Ripstream {
  return createRipstream({ parsers: createInProcessParsers() });
}

export interface StandardIsolationOptions extends Omit<NodeIsolatorOptions, "ripstream" | "inProcessRipstream" | "childModule"> {}

export interface StandardIsolation {
  /** Owns the children and the memory pool it created; the caller disposes it. */
  readonly isolator: NodeIsolator;
  /** `parse` and `parseRecursive` go through the isolator; `detect` is answered in this process. */
  readonly ripstream: IsolatedRipstream;
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
  const full = createRipstream();
  const restricted = createInProcessRipstream();

  // Set before the first request can arrive; the isolator only reads this when a request is parsed in-process.
  let isolator: NodeIsolator | undefined;
  const inProcess = (): Ripstream => (isolator?.status().mode === "off" ? full : restricted);
  const inProcessRipstream: IsolatorRipstream = {
    detect: (source, detectOptions) => inProcess().detect(source, detectOptions),
    parse: (source, parseOptions) => inProcess().parse(source, parseOptions),
    parseRecursive: (source, parseOptions) => inProcess().parseRecursive(source, parseOptions),
  };

  isolator = await createNodeIsolator({
    ...options,
    ripstream: full,
    inProcessRipstream,
    childModule: isolationChildPath(),
  });
  return { isolator, ripstream: createIsolatedRipstream({ isolator, detector: full }) };
}
