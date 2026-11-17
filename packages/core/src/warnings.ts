import { LowYieldError } from "./errors.ts";
import type { Metadata } from "./metadata.ts";
import { CONTEXT_KEYS, type ParseContext } from "./parse-context.ts";
import { TIKA_KEYS } from "./tika-keys.ts";

/**
 * What a parse says about how much of a document it could read (tikajs-icjf, docs/warnings.md). A result with no
 * warning read everything it was asked to. Data on `ParseResult.warnings` and `ParseRecord.warnings`, recorded by
 * default; `onLowYield: "throw"` turns the ones `isLowYield` names into a `LowYieldError`. Text, metadata and `tk:` keys
 * are not changed by any of it.
 */
export type ParseWarning = ImageOnlyWarning | RepairedWarning | TruncatedWarning | PartialWarning;

/** Set on a warning raised for an embedded document of a plain `parse`: its embedded resource path. Absent for the document itself. */
interface WarningPath {
  readonly path?: string;
}

/** PDF pages that paint an image and show no text: `pages` of `of`, the first {@link MAX_PAGE_NUMBERS} numbered (1-based); `chars` is the document's total. */
export interface ImageOnlyWarning extends WarningPath {
  readonly kind: "image-only";
  readonly pages: number;
  readonly of: number;
  readonly pageNumbers: readonly number[];
  readonly chars: number;
}

/** PDF read through a recovery (`tk:pdf:repaired`): `steps` are `tk:pdf:repair-steps`; `of` is the page count, `chars` the document's total. */
export interface RepairedWarning extends WarningPath {
  readonly kind: "repaired";
  readonly steps: readonly string[];
  readonly of: number;
  readonly chars: number;
}

/** The limits whose truncation (`onOutputLimit` / `onEmbeddedLimit: "truncate"`) a result reports. */
export const TRUNCATION_LIMITS = ["outputChars", "embeddedResources", "zipEntries"] as const;
export type TruncationLimit = (typeof TRUNCATION_LIMITS)[number];

/** A limit the caller chose to truncate at cut the document short. */
export interface TruncatedWarning extends WarningPath {
  readonly kind: "truncated";
  readonly limit: TruncationLimit;
}

/** What the parts of a `partial` warning are: PDF pages, xlsx sheets, archive entries, other embedded resources, or warnings dropped past the cap (docs/warnings.md). */
export const PARTIAL_REASONS = ["pages-failed", "sheets-failed", "entries-failed", "embedded-failed", "warnings-capped"] as const;
export type PartialReason = (typeof PARTIAL_REASONS)[number];

/** `failed` of the document's `of` parts could not be read. */
export interface PartialWarning extends WarningPath {
  readonly kind: "partial";
  readonly reason: PartialReason;
  readonly failed: number;
  readonly of: number;
}

/** "record" (default) keeps the warnings on the result; "throw" raises a `LowYieldError` for a low-yield one. */
export type LowYieldPolicy = "record" | "throw";

/** Most warnings one result keeps; the rest are counted in a `warnings-capped` warning. */
export const MAX_WARNINGS = 100;
/** Most a result can carry: the cap, the truncation flags and the `warnings-capped` marker. What the isolation frames accept. */
export const MAX_WARNINGS_PER_RESULT = MAX_WARNINGS + TRUNCATION_LIMITS.length + 1;
/** Most page numbers an `image-only` warning lists. */
export const MAX_PAGE_NUMBERS = 100;
/** Longest `path` of a warning: a longer one is cut. */
export const MAX_WARNING_PATH_CHARS = 1024;
/** Most repair steps a `repaired` warning lists, and the longest step. */
const MAX_STEPS = 32;
const MAX_STEP_CHARS = 100;

/** Characters per page below which a PDF counts as yielding almost nothing (a scan gives none or a handful; prose is hundreds). */
export const LOW_YIELD_CHARS_PER_PAGE = 20;

/**
 * Whether a warning is low yield, the kind `onLowYield: "throw"` refuses: `partial` always; `image-only` and `repaired`
 * when the document gave under {@link LOW_YIELD_CHARS_PER_PAGE} characters a page (`chars < 20 * max(1, of)`);
 * `truncated` never (the caller asked for the cut).
 */
export function isLowYield(warning: ParseWarning): boolean {
  switch (warning.kind) {
    case "partial":
      return true;
    case "image-only":
    case "repaired":
      return warning.chars < LOW_YIELD_CHARS_PER_PAGE * Math.max(1, warning.of);
    case "truncated":
      return false;
  }
}

/** The warnings of `warnings` that are low-yield, in order. */
export function lowYieldWarnings(warnings: readonly ParseWarning[]): ParseWarning[] {
  return warnings.filter(isLowYield);
}

export function assertLowYieldPolicy(value: unknown): void {
  if (value !== undefined && value !== "record" && value !== "throw") {
    throw new TypeError(`onLowYield must be "record" or "throw", got ${String(value)}`);
  }
}

/** Throws a `LowYieldError` when `policy` is "throw" and `warnings` holds a low-yield one. */
export function enforceLowYield(policy: LowYieldPolicy | undefined, warnings: readonly ParseWarning[]): void {
  if (policy !== "throw") return;
  const low = lowYieldWarnings(warnings);
  if (low.length > 0) throw new LowYieldError(low);
}

/** What a recursive parse answers for `enforceLowYield`: every record's warnings, each named by its record's path (the container's have none). */
export function recordWarnings(
  records: readonly { readonly warnings?: readonly ParseWarning[]; readonly embeddedResourcePath: string; readonly depth: number }[],
): ParseWarning[] {
  const all: ParseWarning[] = [];
  for (const record of records) {
    for (const warning of record.warnings ?? []) {
      all.push(record.depth === 0 || warning.path !== undefined ? warning : { ...warning, path: clipPath(record.embeddedResourcePath) });
    }
  }
  return all;
}

type WarningInput = ParseWarning extends infer W ? (W extends unknown ? Omit<W, "path"> : never) : never;

interface Tally {
  readonly path: string;
  readonly reason: Exclude<PartialReason, "warnings-capped">;
  failed: number;
  of: number;
}

interface Store {
  readonly items: ParseWarning[];
  readonly tallies: Map<string, Tally>;
  dropped: number;
}

function clipPath(path: string): string {
  return path.length > MAX_WARNING_PATH_CHARS ? path.slice(0, MAX_WARNING_PATH_CHARS) : path;
}

/**
 * Collects the warnings of one document (a recursive record) or of a whole plain parse. A parser reaches it through the
 * parse context (`addParseWarning`, `tallyPart`) and never builds one. A plain parse shares one store among the
 * documents it reads, each through a scope that names its path; a recursive parse gives each record a store of its own.
 */
export class WarningSink {
  readonly #store: Store;
  readonly #path: string;

  constructor(store?: Store, path = "") {
    this.#store = store ?? { items: [], tallies: new Map(), dropped: 0 };
    this.#path = path;
  }

  /** A view of this sink for the embedded document at `path`: what it adds is the same store's, named by the path. */
  scoped(path: string): WarningSink {
    return new WarningSink(this.#store, clipPath(path));
  }

  add(warning: WarningInput): void {
    if (this.#size() >= MAX_WARNINGS) {
      this.#store.dropped++;
      return;
    }
    this.#store.items.push(Object.freeze(this.#path === "" ? { ...warning } : { ...warning, path: this.#path }) as ParseWarning);
  }

  /** Counts one part of the document (a page, an entry, an embedded resource) and whether it was read. */
  tally(reason: Tally["reason"], ok: boolean): void {
    const key = `${this.#path}\u0000${reason}`;
    let tally = this.#store.tallies.get(key);
    if (tally === undefined) {
      if (this.#size() >= MAX_WARNINGS) {
        if (!ok) this.#store.dropped++;
        return;
      }
      tally = { path: this.#path, reason, failed: 0, of: 0 };
      this.#store.tallies.set(key, tally);
    }
    tally.of++;
    if (!ok) tally.failed++;
  }

  #size(): number {
    return this.#store.items.length + this.#store.tallies.size;
  }

  /**
   * The warnings, in the order they were raised, then the failure tallies, then the truncation flags `metadata` carries.
   * A tally with nothing failed is no warning. Safe to call more than once.
   */
  finish(metadata: Metadata): readonly ParseWarning[] {
    const out: ParseWarning[] = [...this.#store.items];
    for (const { path, reason, failed, of } of this.#store.tallies.values()) {
      if (failed > 0) out.push(Object.freeze({ kind: "partial", reason, failed, of, ...(path === "" ? {} : { path }) }));
    }
    if (metadata.get(TIKA_KEYS.WRITE_LIMIT_REACHED) === "true") out.push(Object.freeze({ kind: "truncated", limit: "outputChars" }));
    if (metadata.get(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT_REACHED) === "true") {
      const limit = metadata.get(TIKA_KEYS.EMBEDDED_RESOURCE_LIMIT) === "maxZipEntries" ? "zipEntries" : "embeddedResources";
      out.push(Object.freeze({ kind: "truncated", limit }));
    }
    if (this.#store.dropped > 0) {
      out.push(
        Object.freeze({ kind: "partial", reason: "warnings-capped", failed: this.#store.dropped, of: this.#store.dropped + MAX_WARNINGS }),
      );
    }
    return Object.freeze(out);
  }
}

/** Notes a warning on the document being parsed. A parse that collects none (a parser run on its own) drops it. */
export function addParseWarning(ctx: ParseContext, warning: WarningInput): void {
  ctx.get(CONTEXT_KEYS.WARNINGS)?.add(warning);
}

/**
 * Counts one part of the document being parsed (a page, an archive entry, an embedded resource) and whether it was read;
 * a document with a part that was not gets a `partial` warning naming how many, at the end of the parse.
 */
export function tallyPart(ctx: ParseContext, reason: Exclude<PartialReason, "warnings-capped">, ok: boolean): void {
  ctx.get(CONTEXT_KEYS.WARNINGS)?.tally(reason, ok);
}

// ---- the wire -------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const oneOf = (names: readonly string[]) => (value: unknown): boolean => typeof value === "string" && names.includes(value);
const isList = (max: number, item: (value: unknown) => boolean) => (value: unknown): boolean =>
  Array.isArray(value) && value.length <= max && value.every(item);

/** The fields of each kind and what makes one valid. A field that is not here, or a kind that is not, is refused. */
const WIRE_FIELDS: Readonly<Record<ParseWarning["kind"], Readonly<Record<string, (value: unknown) => boolean>>>> = {
  "image-only": { pages: isCount, of: isCount, pageNumbers: isList(MAX_PAGE_NUMBERS, isCount), chars: isCount },
  repaired: {
    steps: isList(MAX_STEPS, (step) => typeof step === "string" && step.length <= MAX_STEP_CHARS),
    of: isCount,
    chars: isCount,
  },
  truncated: { limit: oneOf(TRUNCATION_LIMITS) },
  partial: { reason: oneOf(PARTIAL_REASONS), failed: isCount, of: isCount },
};

/**
 * Checks a list of warnings that came from an isolation child (hostile input), field by field, and returns it as plain
 * data, or says what is wrong. Strict: an unknown kind or field, a count that is not a whole number or a list over its
 * bound is refused, so a child cannot make the parent hold more than {@link MAX_WARNINGS_PER_RESULT} small objects.
 */
export function parseWireWarnings(value: unknown): ParseWarning[] | string {
  if (!Array.isArray(value)) return "warnings must be an array";
  if (value.length > MAX_WARNINGS_PER_RESULT) return `warnings has more than ${MAX_WARNINGS_PER_RESULT} entries`;
  const out: ParseWarning[] = [];
  for (const item of value as unknown[]) {
    const warning = parseWireWarning(item);
    if (typeof warning === "string") return `warnings[]: ${warning}`;
    out.push(warning);
  }
  return out;
}

function parseWireWarning(value: unknown): ParseWarning | string {
  if (!isObject(value)) return "must be an object";
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.hasOwn(WIRE_FIELDS, kind)) return "unknown kind";
  const fields = WIRE_FIELDS[kind as ParseWarning["kind"]];
  for (const key of Object.keys(value)) {
    if (key !== "kind" && key !== "path" && !Object.hasOwn(fields, key)) return `${kind}: unexpected field "${key}"`;
  }
  const out: Obj = { kind };
  for (const [key, valid] of Object.entries(fields)) {
    if (!valid(value[key])) return `${kind}: ${key} is not valid`;
    out[key] = Array.isArray(value[key]) ? [...(value[key] as unknown[])] : value[key];
  }
  const path = value.path;
  if (path !== undefined) {
    if (typeof path !== "string" || path.length > MAX_WARNING_PATH_CHARS) return "path must be a string of at most 1024 characters";
    out.path = path;
  }
  return out as unknown as ParseWarning;
}
