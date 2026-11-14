/**
 * Plaintext TF1 scoring, ported from xberg's benchmark harness
 * (tools/benchmark-harness/src/quality/mod.rs, MIT). Only the plaintext path is ported:
 * Tika and ripstream emit plain text, so the markdown structural score (SF1) never applies.
 *
 *   quality = f1_text                         when the ground truth has no numeric token
 *   quality = 0.6 * f1_text + 0.4 * f1_numeric otherwise
 *
 * Tokens: markdown links and images reduced to their text, bare URLs dropped, invisible
 * characters removed, NFKC, lowercase, `|` as a separator, split on Unicode white space,
 * keep alphanumerics plus `.` and `,`, trim `.`/`,` at the ends, CJK runs as bigrams, numbers
 * normalised ("15.0" = "15", "1,000" = "1000").
 */

export interface QualityMetrics {
  readonly f1Text: number;
  readonly f1Numeric: number;
  readonly quality: number;
  /** quality >= 0.95, as the harness's `correct`. */
  readonly correct: boolean;
  readonly extractedTokens: number;
  readonly truthTokens: number;
}

const MD_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL = /(?:https?:\/\/|www\.)\S+/g;
const INVISIBLE = /[­​‌‍﻿]/g;
const WHITE_SPACE = /\p{White_Space}+/u;
/** Rust `char::is_alphanumeric`: Alphabetic or Numeric (Nd, Nl, No). */
const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;
const NUMERIC = /\p{N}/u;
/** What Rust's `str::parse::<f64>` accepts once signs are gone (the tokenizer drops them). */
const RUST_FLOAT = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e\d+)?$/;

export function computeQuality(extracted: string, groundTruth: string): QualityMetrics {
  const extractedTokens = tokenize(extracted);
  const truthTokens = tokenize(groundTruth);
  const f1Text = computeF1(extractedTokens, truthTokens);
  const truthNumeric = truthTokens.filter(isNumericToken);
  const f1Numeric = computeF1(extractedTokens.filter(isNumericToken), truthNumeric);
  const quality = truthNumeric.length === 0 ? f1Text : 0.6 * f1Text + 0.4 * f1Numeric;
  return {
    f1Text,
    f1Numeric,
    quality,
    correct: quality >= 0.95,
    extractedTokens: extractedTokens.length,
    truthTokens: truthTokens.length,
  };
}

export function tokenize(text: string): string[] {
  const stripped = text.replace(MD_IMAGE, "$1").replace(MD_LINK, "$1").replace(BARE_URL, "");
  const words = stripped
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("|", " ")
    .split(WHITE_SPACE);
  const tokens: string[] = [];
  for (const word of words) {
    let kept = "";
    for (const character of word) {
      if (character === "." || character === "," || ALPHANUMERIC.test(character)) kept += character;
    }
    const trimmed = kept.replace(/^[.,]+|[.,]+$/g, "");
    if (trimmed !== "") tokens.push(trimmed);
  }
  return expandCjkBigrams(tokens);
}

/** Multiset F1. Both sides empty is 1, exactly one side empty is 0. */
export function computeF1(extracted: readonly string[], truth: readonly string[]): number {
  if (extracted.length === 0 && truth.length === 0) return 1;
  if (extracted.length === 0 || truth.length === 0) return 0;
  const extractedCounts = countTokens(extracted);
  let intersection = 0;
  for (const [token, count] of countTokens(truth)) {
    intersection += Math.min(count, extractedCounts.get(token) ?? 0);
  }
  const precision = intersection / extracted.length;
  const recall = intersection / truth.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export function normalizeNumericToken(token: string): string {
  let digits = 0;
  for (const character of token) if (character >= "0" && character <= "9") digits++;
  if (digits === 0 || digits > 15) return token;
  const candidate = isThousandsGrouped(token) ? token.replaceAll(",", "") : token;
  if (!RUST_FLOAT.test(candidate)) return token;
  return formatRustFloat(Number(candidate));
}

/** Rust's `{}` for f64: shortest round-trip digits, never exponent notation. */
export function formatRustFloat(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return "inf";
  const text = String(value);
  const match = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const digits = (match[1] ?? "") + (match[2] ?? "");
  const exponent = Number(match[3]);
  if (exponent >= 0) {
    const integerLength = exponent + 1;
    if (digits.length <= integerLength) return digits + "0".repeat(integerLength - digits.length);
    return `${digits.slice(0, integerLength)}.${digits.slice(integerLength)}`;
  }
  return `0.${"0".repeat(-exponent - 1)}${digits}`;
}

function isThousandsGrouped(token: string): boolean {
  const integerPart = token.split(".")[0] ?? "";
  const groups = integerPart.split(",");
  if (groups.length < 2) return false;
  const [first, ...rest] = groups;
  if (first === undefined || !/^\d{1,3}$/.test(first)) return false;
  return rest.every((group) => /^\d{3}$/.test(group));
}

function isNumericToken(token: string): boolean {
  return NUMERIC.test(token);
}

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function expandCjkBigrams(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (const token of tokens) {
    const characters = Array.from(token);
    let cjkRun: string[] = [];
    let start = 0;
    while (start < characters.length) {
      const cjk = isCjk(characters[start] ?? "");
      let end = start + 1;
      while (end < characters.length && isCjk(characters[end] ?? "") === cjk) end++;
      const run = characters.slice(start, end);
      if (cjk) {
        cjkRun.push(...run);
      } else if (!run.every((character) => character === "." || character === ",")) {
        pushBigrams(result, cjkRun);
        cjkRun = [];
        result.push(normalizeNumericToken(run.join("")));
      }
      start = end;
    }
    pushBigrams(result, cjkRun);
  }
  return result;
}

function pushBigrams(result: string[], run: readonly string[]): void {
  if (run.length === 1) {
    result.push(run[0] ?? "");
    return;
  }
  for (let index = 0; index + 1 < run.length; index++) result.push(`${run[index]}${run[index + 1]}`);
}

const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff],
  [0x2e80, 0x2eff],
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3130, 0x318f],
  [0x31f0, 0x31ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa960, 0xa97f],
  [0xac00, 0xd7af],
  [0xd7b0, 0xd7ff],
  [0xf900, 0xfaff],
  [0xff66, 0xff9f],
  [0x20000, 0x2fa1f],
];

function isCjk(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return CJK_RANGES.some(([low, high]) => code >= low && code <= high);
}
