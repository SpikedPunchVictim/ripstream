import { readFileSync } from "node:fs";
import type { LanguageDetector, LanguageIdentifier, LanguageResult } from "@spikedpunch/ripstream-core";
import { CHARSOUP_MAX_TEXT_LENGTH, SaltedNgramFeatureExtractor } from "./charsoup-features.ts";
import { CharSoupModel } from "./charsoup-model.ts";

/*
 * Apache Tika 4.2.0's `CharSoupLanguageDetector` (tika-langdetect-charsoup), Apache License 2.0, the detector Tika's server
 * and `LanguageDetector.getDefaultLanguageDetector()` use: 204 languages, one verdict over the whole text.
 *
 * Inference is raw logits throughout. Confusable languages (msa/ind, xho/zul, bel/be-x-old, yue/zho) are collapsed: the
 * group's logits are combined with logsumexp and given to its best member, the others masked, so that the model reports
 * confidence in the group rather than in a noisy choice within it. The confidence is the margin between the top two logits,
 * `sigmoid(top - second)`.
 *
 * Java's `float` is kept 32-bit with `Math.fround` and `Float32Array` where the Java rounds, so the scores are Tika's.
 * Script gating, which Tika's `applyScriptGate` leaves a no-op, is left out; so are its charset-comparison helpers.
 */

/** Where Tika's `langdetect-20260320.bin` is shipped: `data/`, next to `src/` and `dist/`. */
export const CHARSOUP_MODEL_FILE: URL = new URL("../data/langdetect-20260320.bin", import.meta.url);

/** Tika's `LanguageConfidence`: how far the verdict is to be trusted. */
export type CharSoupConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** Tika's `LanguageResult`, less its detector-agnostic confidence score. `language` is "" and `rawScore` 0 when none was found. */
export interface CharSoupResult {
  /** ISO 639-3, apart from `be-x-old`, `cdo-x-rom` and `hak-x-rom`; "" when there is none. */
  readonly language: string;
  readonly confidence: CharSoupConfidence;
  /** A 32-bit float in [0, 1]: `sigmoid(top logit - second logit)` for the verdict. */
  readonly rawScore: number;
}

export interface CharSoupOptions {
  /** The characters read from the start of the text, Tika's `maxLength`. Default 100,000. A value of 0 or less reads none. */
  readonly maxLength?: number;
}

/** `confusables.txt`: languages the model cannot tell apart by character n-grams. */
const CONFUSABLE_GROUPS: ReadonlyArray<readonly string[]> = [
  ["msa", "ind"],
  ["xho", "zul"],
  ["bel", "be-x-old"],
  ["yue", "zho"],
];

const NO_LANGUAGE: CharSoupResult = Object.freeze({ language: "", confidence: "NONE", rawScore: 0 });

const MASKED_LOGIT = Math.fround(-1e30);
const SCORE_FLOOR = 0.5;
const HIGH_SCORE = Math.fround(0.9);
const MEDIUM_SCORE = Math.fround(0.7);

interface Loaded {
  readonly model: CharSoupModel;
  readonly extractor: SaltedNgramFeatureExtractor;
  readonly groups: readonly Int32Array[];
  readonly supported: ReadonlySet<string>;
}

let loaded: Loaded | null = null;

/** The model Tika ships, read once, when it is first needed. */
function builtIn(): Loaded {
  if (loaded !== null) return loaded;
  const model = CharSoupModel.load(new Uint8Array(readFileSync(CHARSOUP_MODEL_FILE)));
  // The features must be the ones the model was trained on: SaltedNgram with trigrams, 4-grams, script blocks and word bigrams.
  const extractorFlags = model.featureFlags & ~(1 << 10);
  if (extractorFlags !== (1 << 0 | 1 << 7 | 1 << 9 | 1 << 11)) {
    throw new Error(`Feature flag mismatch for the language model: it has 0x${model.featureFlags.toString(16)}, the extractor is for 0xa81 and the L2 norm`);
  }
  const indexOf = new Map(model.labels.map((label, index) => [label, index]));
  const groups: Int32Array[] = model.labels.map((_, index) => Int32Array.of(index));
  for (const group of CONFUSABLE_GROUPS) {
    const members = group.flatMap((label) => indexOf.get(label) ?? []);
    if (members.length < 2) continue;
    const indices = Int32Array.from(members);
    for (const member of members) groups[member] = indices;
  }
  loaded = {
    model,
    extractor: new SaltedNgramFeatureExtractor(model.numBuckets, true),
    groups,
    supported: new Set(model.labels),
  };
  return loaded;
}

/** `Character.isWhitespace` for every char of the text: Java's `isBlank`, which is not JavaScript's `trim`. */
function isJavaBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const space =
      (c >= 0x09 && c <= 0x0d) ||
      (c >= 0x1c && c <= 0x20) ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x2006) ||
      (c >= 0x2008 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x205f ||
      c === 0x3000;
    if (!space) return false;
  }
  return true;
}

const sigmoid = (x: number): number => Math.fround(1 / (1 + Math.exp(-x)));

/** `logsumexp` of the logits of a group, assigned to its best member; the other members masked. Returns a new array. */
function collapseGroups(logits: Float32Array, groups: readonly Int32Array[]): Float32Array {
  const collapsed = Float32Array.from(logits);
  const visited = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const group = groups[i]!;
    if (visited[i] === 1 || group.length <= 1) continue;
    let best = group[0]!;
    let maxLogit = logits[best]!;
    for (const index of group) {
      if (logits[index]! > maxLogit) {
        maxLogit = logits[index]!;
        best = index;
      }
      visited[index] = 1;
    }
    let sumExp = 0;
    for (const index of group) sumExp = Math.fround(sumExp + Math.exp(Math.fround(logits[index]! - maxLogit)));
    const groupLogit = Math.fround(maxLogit + Math.fround(Math.log(sumExp)));
    for (const index of group) collapsed[index] = index === best ? groupLogit : MASKED_LOGIT;
  }
  return collapsed;
}

/** Shannon entropy in bits, from the logits: `(logsumexp(L) - E[L under softmax]) / ln 2`. */
function entropyFromLogits(logits: Float32Array): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const v of logits) if (v > max) max = v;
  let sumExp = 0;
  for (const v of logits) sumExp = Math.fround(sumExp + Math.exp(Math.fround(v - max)));
  const lse = Math.fround(max + Math.fround(Math.log(sumExp)));
  let weighted = 0;
  for (const l of logits) weighted += Math.exp(Math.fround(l - lse)) * l;
  return Math.fround((lse - weighted) / Math.log(2));
}

function toConfidence(score: number, entropy: number): CharSoupConfidence {
  if (score > HIGH_SCORE) return "HIGH";
  if (score > MEDIUM_SCORE) return entropy < 2 ? "MEDIUM" : "LOW";
  if (score > SCORE_FLOOR) return "LOW";
  return "NONE";
}

/** The CharSoup language detector: Tika's own model and pipeline, loaded on first use. */
export class CharSoupLanguageDetector implements LanguageDetector, LanguageIdentifier {
  /** The ISO 639-3 codes the built-in model can answer with. */
  static get supportedLanguages(): ReadonlySet<string> {
    return builtIn().supported;
  }

  /**
   * The language of a text as Tika's `CharSoupLanguageDetector.detect` answers it: the characters up to `maxLength`,
   * scored once as a whole. Blank text, and text whose best language does not lead the next by any margin, are `NONE`.
   */
  identify(text: string, options: CharSoupOptions = {}): CharSoupResult {
    const maxLength = options.maxLength ?? CHARSOUP_MAX_TEXT_LENGTH;
    const buffered = maxLength <= 0 ? "" : text.length > maxLength ? text.slice(0, maxLength) : text;
    if (isJavaBlank(buffered)) return NO_LANGUAGE;

    const { model, extractor, groups } = builtIn();
    const logits = collapseGroups(model.predictLogits(extractor.extract(buffered)), groups);
    const entropy = entropyFromLogits(logits);

    let topIndex = 0;
    let top = logits[0]!;
    let second = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < logits.length; i++) {
      const logit = logits[i]!;
      if (logit > top) {
        second = top;
        topIndex = i;
        top = logit;
      } else if (logit > second) {
        second = logit;
      }
    }
    const rawScore = sigmoid(Math.fround(top - second));
    const confidence = toConfidence(rawScore, entropy);
    if (confidence === "NONE") return NO_LANGUAGE;
    return { language: model.labels[topIndex]!, confidence, rawScore };
  }

  /** The `LanguageDetector` contract: ISO 639-3, the raw score as the confidence, and "und" when no language was found. */
  detect(text: string): LanguageResult {
    const result = this.identify(text);
    return {
      language: result.language === "" ? "und" : result.language,
      confidence: result.rawScore,
      isReasonablyCertain: result.confidence === "HIGH",
    };
  }
}
