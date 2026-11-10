import type { ParseLimits } from "./parse-context.ts";
import { parseUnpackConfig, type UnpackSettings } from "./unpack-config.ts";

/*
 * The `parse-context` section of a Tika configuration (tika-core 4.2.0: EmbeddedLimits, OutputLimits, TimeoutLimits).
 *
 * Ripstream applies the keys whose limit means the same here, and the boundary is the same where it was compared
 * (ParsingEmbeddedDocumentExtractor.checkEmbeddedLimits against core/src/embedded.ts):
 *
 *   embedded-limits.maxDepth              -> maxNodeDepth          a child deeper than N is refused
 *   embedded-limits.maxCount              -> maxEmbeddedResources  the N+1st embedded document is refused
 *   output-limits.writeLimit              -> maxOutputChars
 *   timeout-limits.totalTaskTimeoutMillis -> maxParseMillis
 *
 * What happens at the limit is not the same. Tika's default is to stop quietly and set a flag (throwOnMaxDepth,
 * throwOnMaxCount, throwOnWriteLimit and throwOnDeadline are false); ripstream fails the parse, which is what Tika does
 * with the flag true. A limit is therefore accepted only beside its flag set to true: accepting `maxCount: 1000` alone
 * would turn Tika's truncated 200 into a 422 without a word. Every key with no ripstream counterpart is refused by
 * name, with the reason.
 *
 * `unpack-config` is not a limit: it says what pipes' UNPACK mode emits (unpack-config.ts) and is passed on as `unpack`.
 */

type Block = "embedded-limits" | "output-limits" | "timeout-limits";

const BLOCKS: readonly Block[] = ["embedded-limits", "output-limits", "timeout-limits"];

const INT_MAX = 2 ** 31 - 1;

interface Applied {
  readonly limit: keyof ParseLimits;
  /** Inclusive bounds of a valid value. */
  readonly min: number;
  readonly max: number;
  /** The Tika flag that must be true beside this limit. */
  readonly flag: string;
  /** A value that needs no flag because it sets no limit (writeLimit -1). */
  readonly unlimited?: number;
  /** Said when the value is -1 and -1 is not accepted. */
  readonly noUnlimited?: string;
}

const APPLIED: Readonly<Record<Block, Readonly<Record<string, Applied>>>> = {
  "embedded-limits": {
    maxDepth: { limit: "maxNodeDepth", min: 0, max: INT_MAX, flag: "throwOnMaxDepth", noUnlimited: "ripstream bounds embedded depth" },
    maxCount: { limit: "maxEmbeddedResources", min: 0, max: INT_MAX, flag: "throwOnMaxCount", noUnlimited: "ripstream bounds embedded count" },
  },
  "output-limits": {
    writeLimit: { limit: "maxOutputChars", min: -1, max: INT_MAX, flag: "throwOnWriteLimit", unlimited: -1 },
  },
  "timeout-limits": {
    totalTaskTimeoutMillis: { limit: "maxParseMillis", min: 1, max: INT_MAX, flag: "throwOnDeadline" },
  },
};

/** The flags: Tika's throw switches. They are not limits, so they are read and checked, never applied. */
const FLAGS: Readonly<Record<Block, readonly string[]>> = {
  "embedded-limits": ["throwOnMaxDepth", "throwOnMaxCount"],
  "output-limits": ["throwOnWriteLimit"],
  "timeout-limits": ["throwOnDeadline"],
};

const REFUSED: Readonly<Record<Block, Readonly<Record<string, string>>>> = {
  "embedded-limits": {},
  "output-limits": {
    maxXmlDepth: "ripstream has no limit on XML element nesting among its parse limits",
    maxPackageEntryDepth: "Tika deprecated it in favour of embedded-limits.maxDepth",
    zipBombThreshold:
      "Tika compares the output characters with the input bytes once a character threshold is passed; ripstream's maxDecompressionRatio compares decompressed with compressed bytes per archive entry, which is another check",
    zipBombRatio:
      "Tika compares the output characters with the input bytes once a character threshold is passed; ripstream's maxDecompressionRatio compares decompressed with compressed bytes per archive entry, which is another check",
  },
  "timeout-limits": {
    progressTimeoutMillis: "ripstream has no stall detector, only the total deadline (totalTaskTimeoutMillis)",
  },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a `parse-context` section into the ripstream limits it applies and reports everything Tika would accept and
 * ripstream cannot honor. It reads each value of the caller's object once, and returns a copy.
 */
export function parseParseContextSection(value: unknown): {
  limits: Partial<ParseLimits>;
  /** `output-limits.throwOnWriteLimit` was set to true: reaching the output limit must fail, even where it would truncate. */
  throwOnWriteLimit: boolean;
  /** The `unpack-config` component, when the section has one. */
  unpack?: UnpackSettings;
  issues: string[];
} {
  const issues: string[] = [];
  const limits: { -readonly [Key in keyof ParseLimits]?: number } = {};
  let throwOnWriteLimit = false;
  let unpack: UnpackSettings | undefined;
  if (!isObject(value)) return { limits, throwOnWriteLimit, issues: ["parse-context must be an object"] };

  for (const [name, raw] of Object.entries(value)) {
    if (name === "unpack-config") {
      const result = parseUnpackConfig(raw);
      issues.push(...result.issues);
      if (result.issues.length === 0) unpack = result.settings;
      continue;
    }
    if (!(BLOCKS as readonly string[]).includes(name)) {
      issues.push(
        `parse-context: ${JSON.stringify(name)} is not supported: ripstream reads only ${[...BLOCKS, "unpack-config"].join(", ").replace(/, ([^,]*)$/, " and $1")}`,
      );
      continue;
    }
    const block = name as Block;
    const where = `parse-context ${block}`;
    if (!isObject(raw)) {
      issues.push(`${where} must be an object`);
      continue;
    }
    const settings = Object.entries(raw);
    const get = (key: string): unknown => settings.find(([candidate]) => candidate === key)?.[1];

    for (const [key] of settings) {
      const refusal = REFUSED[block][key];
      if (refusal !== undefined) issues.push(`${where}: ${key} is not supported: ${refusal}`);
      else if (APPLIED[block][key] === undefined && !FLAGS[block].includes(key)) {
        issues.push(`${where}: unknown setting ${JSON.stringify(key)}`);
      }
    }
    for (const flag of FLAGS[block]) {
      const flagValue = get(flag);
      if (flagValue !== undefined && typeof flagValue !== "boolean") issues.push(`${where}: ${flag} must be a boolean`);
      if (flag === "throwOnWriteLimit" && flagValue === true) throwOnWriteLimit = true;
    }
    for (const [key, rule] of Object.entries(APPLIED[block])) {
      const number = get(key);
      if (number === undefined) continue;
      if (number === -1 && rule.noUnlimited !== undefined) {
        issues.push(`${where}: ${rule.noUnlimited}: -1 (unlimited) is not available; give a limit of 0 or more`);
        continue;
      }
      if (typeof number !== "number" || !Number.isSafeInteger(number) || Object.is(number, -0) || number < rule.min || number > rule.max) {
        issues.push(`${where}: ${key} must be an integer from ${rule.min} to ${rule.max}`);
        continue;
      }
      if (number !== rule.unlimited && get(rule.flag) !== true) {
        issues.push(
          `${where}: ${key} needs ${rule.flag}: true. ripstream fails the parse when the limit is exceeded (a LimitExceededError: exit 3, HTTP 422); ` +
            `Tika, with ${rule.flag} false (its default), stops quietly and sets a flag. Set ${rule.flag} to true to accept that, or remove ${key}`,
        );
        continue;
      }
      limits[rule.limit] = number;
    }
  }
  return { limits, throwOnWriteLimit, ...(unpack === undefined ? {} : { unpack }), issues };
}
