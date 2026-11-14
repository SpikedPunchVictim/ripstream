import { COMPONENT_ID_PATTERN, SYSTEM_COMPONENT_PREFIX } from "@spikedpunch/ripstream-core";
import type { OnParseException } from "./index.ts";

/*
 * The unit of work (tikajs-68os.6.2, evidence in tasks/parity/audits/pipes-model-spike.md): Tika's FetchEmitTuple, plain
 * data that names where the bytes are and where the result goes. Data, not a closure or the bytes, so it can be queued,
 * posted, checkpointed and retried, and so the worker that takes it reads the bytes itself, which is what lets a slow
 * fetcher run concurrently.
 */

export interface FetchEmitTuple {
  /** What reports call the input. */
  readonly id: string;
  /** The id of the fetcher that reads the bytes. */
  readonly fetcher: string;
  /** What the fetcher is asked for: a path under its base, a URL. */
  readonly fetchKey: string;
  /** The id of the emitter that writes the result. Absent: the engine's default emitter. */
  readonly emitter?: string;
  /** Where the emitter puts the result. Absent: the tuple's id. */
  readonly emitKey?: string;
  /** What to do with a document that cannot be read. Absent: the run's choice, which is EMIT. */
  readonly onParseException?: OnParseException;
}

export interface FetchContext {
  /** Aborted when the run ends before this fetch is done. */
  readonly signal: AbortSignal;
}

/** Reads one input's bytes by key. Throws when it cannot: the input's result is FETCH_EXCEPTION and the run goes on. */
export interface Fetcher {
  fetch(key: string, context: FetchContext): Promise<Uint8Array>;
  /**
   * A local file the bytes are in, for a parser that can read a path itself (the isolated child, or core's own
   * stream). The engine hands `{ path }` to the ripstream instead of the whole body, so a large input costs no parent
   * memory. Optional: a fetcher over a network has no path. The key is validated as `fetch` validates it.
   */
  resolve?(key: string, context: FetchContext): Promise<string>;
  close?(): Promise<void> | void;
}

/** What a run takes its work from: tuples, cheaply, without reading any bytes. An iterator that throws ends the run. */
export type PipesIterator = AsyncIterable<FetchEmitTuple>;

const TUPLE_KEYS = ["id", "fetcher", "fetchKey", "emitter", "emitKey", "onParseException"] as const;

/** Tika's FetchEmitTuple fields that ripstream's engine does not act on, and why. They are refused, not dropped. */
const REFUSED: Readonly<Record<string, string>> = {
  fetchRangeStart: "needs a fetcher that reads a byte range, which ripstream's fetchers do not",
  fetchRangeEnd: "needs a fetcher that reads a byte range, which ripstream's fetchers do not",
  metadata: "would seed the parse with metadata, which ripstream's parsers are not given",
  preset: "names a parse-context preset; ripstream's pipes take their settings from the run, not the tuple",
  parseContext: "carries per-tuple parser settings; ripstream's pipes take their settings from the run, not the tuple",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `id` may name a fetcher or an emitter that code or a configuration supplies. */
export function componentIdIssue(id: string): string | null {
  if (!COMPONENT_ID_PATTERN.test(id)) return `id ${JSON.stringify(id)} may only use letters, digits, '.', '_' and '-'`;
  if (id.startsWith(SYSTEM_COMPONENT_PREFIX)) return `id ${JSON.stringify(id)} starts with "${SYSTEM_COMPONENT_PREFIX}", which is kept for components the engine supplies`;
  return null;
}

/**
 * Reads a FetchEmitTuple from JSON (a request body, a line of a tuple file). The `id` defaults to the `fetchKey`, as it
 * does in Tika's iterators. A key ripstream does not act on is refused by name.
 */
export function parseFetchEmitTuple(value: unknown): { issues: string[]; tuple: FetchEmitTuple | undefined } {
  if (!isObject(value)) return { issues: ["a tuple must be a JSON object"], tuple: undefined };
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    if ((TUPLE_KEYS as readonly string[]).includes(key)) continue;
    issues.push(`${key} ${REFUSED[key] ?? `is not a tuple field (a tuple has ${TUPLE_KEYS.join(", ")})`}`);
  }
  const text = (key: (typeof TUPLE_KEYS)[number], required: boolean): string | undefined => {
    const field = value[key];
    if (field === undefined) {
      if (required) issues.push(`${key} is required`);
      return undefined;
    }
    if (typeof field !== "string" || field.length === 0 || field.includes("\u0000")) {
      issues.push(`${key} must be a non-empty string`);
      return undefined;
    }
    return field;
  };
  const fetcher = text("fetcher", true);
  const fetchKey = text("fetchKey", true);
  const id = text("id", false) ?? fetchKey;
  const emitter = text("emitter", false);
  const emitKey = text("emitKey", false);
  const parse = value.onParseException;
  if (parse !== undefined && parse !== "EMIT" && parse !== "SKIP") issues.push("onParseException must be EMIT or SKIP");
  if (issues.length > 0 || fetcher === undefined || fetchKey === undefined || id === undefined) return { issues, tuple: undefined };
  return {
    issues,
    tuple: {
      id,
      fetcher,
      fetchKey,
      ...(emitter === undefined ? {} : { emitter }),
      ...(emitKey === undefined ? {} : { emitKey }),
      ...(parse === undefined ? {} : { onParseException: parse as OnParseException }),
    },
  };
}
