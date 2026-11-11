import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DocumentSource, EmittedDocument, Emitter, PipeDocument, PipesResult, PipesResultStatus, Reporter } from "./index.ts";
import { PIPES_RESULT_STATUSES } from "./result.ts";
import type { FetchContext, FetchEmitTuple, Fetcher } from "./tuple.ts";

/** CSV source: one document per data row, with the bytes of the row. */
export class CsvSource implements DocumentSource {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  async *fetch(): AsyncIterable<PipeDocument> {
    const lines = (await readFile(this.#path, "utf8")).split(/\r?\n/).filter(Boolean);
    for (let index = 1; index < lines.length; index++) {
      yield { id: `${index}`, data: new TextEncoder().encode(lines[index]!) };
    }
  }
}

/** JSON array source: one document per element, with the element's JSON as its bytes. */
export class JsonSource implements DocumentSource {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  async *fetch(): AsyncIterable<PipeDocument> {
    const value = JSON.parse(await readFile(this.#path, "utf8")) as unknown[];
    for (let index = 0; index < value.length; index++) {
      yield { id: `${index}`, data: new TextEncoder().encode(JSON.stringify(value[index])) };
    }
  }
}

/**
 * Loads an external fetcher module (S3 and other cloud fetchers are optional plugins): the module's `createFetcher`
 * export (or `exportName`) makes a keyed `Fetcher`, once, when the first key is asked for.
 */
export class ModuleFetcher implements Fetcher {
  readonly #moduleUrl: string;
  readonly #exportName: string;
  #loaded: Promise<Fetcher> | undefined;
  constructor(moduleUrl: string, exportName = "createFetcher") {
    this.#moduleUrl = moduleUrl;
    this.#exportName = exportName;
  }
  async fetch(key: string, context: FetchContext): Promise<Uint8Array> {
    const loading = (this.#loaded ??= this.#load());
    // A load that failed is tried again by the next key, not remembered as the answer.
    return (await loading.catch((error: unknown) => {
      this.#loaded = undefined;
      throw error;
    })).fetch(key, context);
  }
  async close(): Promise<void> {
    if (this.#loaded !== undefined) await (await this.#loaded).close?.();
  }
  async #load(): Promise<Fetcher> {
    const module = (await import(this.#moduleUrl)) as Record<string, unknown>;
    const factory = module[this.#exportName];
    if (typeof factory !== "function") throw new Error("Invalid fetcher module");
    return (factory as () => Fetcher)();
  }
}

/** Loads an external emitter module (S3/JDBC/Kafka adapters are optional plugins). */
export class ModuleEmitter implements Emitter {
  readonly #moduleUrl: string;
  readonly #exportName: string;
  constructor(moduleUrl: string, exportName = "createEmitter") {
    this.#moduleUrl = moduleUrl;
    this.#exportName = exportName;
  }
  async emit(document: EmittedDocument): Promise<void> {
    const module = (await import(this.#moduleUrl)) as Record<string, unknown>;
    const factory = module[this.#exportName];
    if (typeof factory !== "function") throw new Error("Invalid emitter module");
    await (factory as () => Emitter)().emit(document);
  }
}

export class StdoutEmitter implements Emitter {
  async emit(document: EmittedDocument): Promise<void> {
    process.stdout.write(document.text ?? `${document.id}\n`);
  }
}

export class JsonlEmitter implements Emitter {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();
  constructor(path: string) { this.#path = path; }
  async emit(document: EmittedDocument): Promise<void> {
    const line = `${JSON.stringify({ id: document.id, text: document.text, metadata: document.metadata })}\n`;
    const run = this.#tail.then(() => appendFile(this.#path, line));
    this.#tail = run.catch(() => undefined); // keep the chain alive after a failed append
    await run; // caller still observes this append's rejection
  }
}

export class HttpEmitter implements Emitter {
  readonly #url: string;
  constructor(url: string) { this.#url = url; }
  async emit(document: EmittedDocument): Promise<void> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: document.id, text: document.text, metadata: document.metadata }),
    });
    if (!response.ok) throw new Error(`Emitter failed: ${response.status}`);
  }
}

export class CompositeEmitter implements Emitter {
  readonly #emitters: readonly Emitter[];
  constructor(emitters: readonly Emitter[]) { this.#emitters = emitters; }
  async emit(document: EmittedDocument): Promise<void> {
    for (const emitter of this.#emitters) await emitter.emit(document);
  }
  async close(): Promise<void> {
    for (const emitter of this.#emitters) await emitter.close?.();
  }
}

/**
 * Which results a reporter writes: Tika's PipesReporterBase `includes` / `excludes`. Both given is an error there
 * and here. Without either, every result.
 */
export interface StatusFilter {
  readonly includes?: readonly PipesResultStatus[];
  readonly excludes?: readonly PipesResultStatus[];
}

/** Whether the filter lets the result through. */
export function wants(filter: StatusFilter, result: PipesResult): boolean {
  if (filter.includes !== undefined && filter.includes.length > 0) return filter.includes.includes(result.status);
  if (filter.excludes !== undefined && filter.excludes.length > 0) return !filter.excludes.includes(result.status);
  return true;
}

/** Refuses a filter that names a status Tika does not have, or that has both includes and excludes. */
export function assertValidFilter(filter: StatusFilter): void {
  for (const [name, list] of [["includes", filter.includes], ["excludes", filter.excludes]] as const) {
    for (const status of list ?? []) {
      if (!(status in PIPES_RESULT_STATUSES)) throw new RangeError(`${name} names no result status: ${String(status)}`);
    }
  }
  if ((filter.includes?.length ?? 0) > 0 && (filter.excludes?.length ?? 0) > 0) {
    throw new RangeError("only one of includes and excludes may be given");
  }
}

/** One line of JSON on stderr for each result the filter lets through (default: every result that is not a plain EMIT_SUCCESS). */
export class LoggingReporter implements Reporter {
  readonly #filter: StatusFilter;
  constructor(filter: StatusFilter = { excludes: ["EMIT_SUCCESS"] }) {
    assertValidFilter(filter);
    this.#filter = filter;
  }
  report(result: PipesResult): void {
    if (wants(this.#filter, result)) console.error(JSON.stringify({ level: result.category === "SUCCESS" ? "info" : "error", ...result }));
  }
}

export interface JsonlReporterOptions {
  /**
   * What to do when the file is already there: "EXCEPTION" refuses (Tika's default for its configuration), "APPEND" adds
   * to it, "REPLACE" empties it first. Default "APPEND". The file is prepared when the reporter is made, so a run does not
   * find out at its end that it had nowhere to write.
   */
  readonly onExists?: "EXCEPTION" | "APPEND" | "REPLACE";
  /** A message longer than this is cut and says how much was cut, as Tika's. Default: never cut. */
  readonly maxMessageLength?: number;
}

/** Tika's FileSystemJsonlReporter.truncate: the cut never splits a surrogate pair. */
function truncateMessage(message: string, max: number): string {
  if (message.length <= max) return message;
  const high = max > 0 && (message.charCodeAt(max - 1) & 0xfc00) === 0xd800;
  const cut = high ? max - 1 : max;
  return `${message.slice(0, cut)}...[truncated ${message.length - cut} chars]`;
}

/** Appends one line of JSON for each result the filter lets through: an audit log of the run, as Tika's file-system-jsonl-reporter. */
export class JsonlReporter implements Reporter {
  readonly #path: string;
  readonly #filter: StatusFilter;
  readonly #maxMessageLength: number;
  #tail: Promise<void> = Promise.resolve();
  constructor(path: string, filter: StatusFilter = {}, options: JsonlReporterOptions = {}) {
    assertValidFilter(filter);
    const maxMessageLength = options.maxMessageLength ?? Number.POSITIVE_INFINITY;
    if (maxMessageLength !== Number.POSITIVE_INFINITY && !(Number.isSafeInteger(maxMessageLength) && maxMessageLength >= 1)) {
      throw new RangeError(`maxMessageLength must be a whole number of at least 1, got ${String(maxMessageLength)}`);
    }
    this.#path = path;
    this.#filter = filter;
    this.#maxMessageLength = maxMessageLength;
    prepareReportFile(path, options.onExists ?? "APPEND");
  }
  async report(result: PipesResult): Promise<void> {
    if (!wants(this.#filter, result)) return;
    const message = result.message === undefined ? undefined : truncateMessage(result.message, this.#maxMessageLength);
    const line = `${JSON.stringify(message === result.message ? result : { ...result, message })}\n`;
    const run = this.#tail.then(() => appendFile(this.#path, line));
    this.#tail = run.catch(() => undefined); // keep the chain alive after a failed append
    await run; // caller still observes this append's rejection
  }
}

export class CompositeReporter implements Reporter {
  readonly #reporters: readonly Reporter[];
  constructor(reporters: readonly Reporter[]) { this.#reporters = reporters; }
  async report(result: PipesResult, tuple?: FetchEmitTuple): Promise<void> {
    for (const reporter of this.#reporters) await reporter.report(result, tuple);
  }
}

/** Makes the report file what `onExists` says it should be, now, so a bad path or an existing file fails the run before it starts. */
function prepareReportFile(path: string, onExists: "EXCEPTION" | "APPEND" | "REPLACE"): void {
  if (existsSync(path) && statSync(path).isDirectory()) throw new RangeError(`${path} is a directory: the report path must be a file`);
  mkdirSync(dirname(path), { recursive: true });
  if (onExists === "EXCEPTION") {
    try {
      writeFileSync(path, "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RangeError(`${path} already exists and onExists is EXCEPTION`);
      throw error;
    }
  } else if (onExists === "REPLACE") {
    writeFileSync(path, "");
  } else if (existsSync(path) && statSync(path).size > 0 && !readFileSync(path).subarray(-1).equals(Buffer.from("\n"))) {
    // A run that died mid-line left a partial one: end it so the next line is not glued to it.
    appendFileSync(path, "\n");
  }
}
