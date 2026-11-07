import { appendFile, readFile } from "node:fs/promises";
import type { EmittedDocument, Emitter, Fetcher, PipeDocument, PipesStats } from "./index.ts";

/** CSV iterator: yields one document per data row. */
export class CsvFetcher implements Fetcher {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  async *fetch(): AsyncIterable<PipeDocument> {
    const lines = (await readFile(this.#path, "utf8")).split(/\r?\n/).filter(Boolean);
    for (let index = 1; index < lines.length; index++) {
      yield { id: `${index}`, data: new TextEncoder().encode(lines[index]!) };
    }
  }
}

/** JSON array iterator: yields one document per element. */
export class JsonFetcher implements Fetcher {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  async *fetch(): AsyncIterable<PipeDocument> {
    const value = JSON.parse(await readFile(this.#path, "utf8")) as unknown[];
    for (let index = 0; index < value.length; index++) {
      yield { id: `${index}`, data: new TextEncoder().encode(JSON.stringify(value[index])) };
    }
  }
}

/** Loads an external fetcher module (S3/cloud adapters are optional plugins). */
export class ModuleFetcher implements Fetcher {
  readonly #moduleUrl: string;
  readonly #exportName: string;
  constructor(moduleUrl: string, exportName = "createFetcher") {
    this.#moduleUrl = moduleUrl;
    this.#exportName = exportName;
  }
  async *fetch(): AsyncIterable<PipeDocument> {
    const module = (await import(this.#moduleUrl)) as Record<string, unknown>;
    const factory = module[this.#exportName];
    if (typeof factory !== "function") throw new Error("Invalid fetcher module");
    const fetcher = (factory as () => Fetcher)();
    yield* fetcher.fetch();
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

export interface Reporter {
  report(stats: PipesStats): Promise<void> | void;
}

export class LoggingReporter implements Reporter {
  report(stats: PipesStats): void {
    console.error(JSON.stringify({ level: "info", ...stats }));
  }
}

export class JsonlReporter implements Reporter {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();
  constructor(path: string) { this.#path = path; }
  async report(stats: PipesStats): Promise<void> {
    const line = `${JSON.stringify(stats)}\n`;
    const run = this.#tail.then(() => appendFile(this.#path, line));
    this.#tail = run.catch(() => undefined); // keep the chain alive after a failed append
    await run; // caller still observes this append's rejection
  }
}

export class CompositeReporter implements Reporter {
  readonly #reporters: readonly Reporter[];
  constructor(reporters: readonly Reporter[]) { this.#reporters = reporters; }
  async report(stats: PipesStats): Promise<void> {
    for (const reporter of this.#reporters) await reporter.report(stats);
  }
}
