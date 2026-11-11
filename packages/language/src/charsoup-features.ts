/*
 * The feature pipeline of Apache Tika 4.2.0's CharSoup language detector: `CharSoupFeatureExtractor.preprocess` and
 * `SaltedNgramFeatureExtractor` (tika-langdetect-charsoup-core), Apache License 2.0.
 *
 * DO NOT CHANGE WHAT THIS COMPUTES. The weights in data/langdetect-20260320.bin were trained on exactly these features:
 * a different hash, a different order of emission or a different treatment of one character silently lowers accuracy,
 * with nothing to say so. The differences from the Java are the ones the languages make:
 *
 *   - `Character.isLetter` is `\p{L}`, `Character.toLowerCase(int)` is the simple lower case (JavaScript's lower case is
 *     the full one, which differs for U+0130 alone, whose first code point is the simple one), `Character.getType == Mn` is
 *     `\p{Mn}`, and `Character.UnicodeScript.of` is `\p{Script=...}`. Both sides follow the Unicode version of their
 *     runtime, so a letter assigned after Java 17's Unicode (13) is judged by Node's tables here and by Tika's there.
 *   - Java's `int` arithmetic is `Math.imul` and `| 0`.
 */

/** The model's number of hash buckets (`langdetect-20260320.bin`). */
export const CHARSOUP_NUM_BUCKETS = 32768;

/** `CharSoupFeatureExtractor.MAX_TEXT_LENGTH`: the longest text anything is extracted from. */
export const CHARSOUP_MAX_TEXT_LENGTH = 100_000;

const FNV_BASIS = 0x811c9dc5 | 0;
const FNV_PRIME = 0x01000193;

const SALT_MID = 0x00;
const SALT_BOW = 0x01;
const SALT_EOW = 0x02;
const SALT_FULL_WORD = 0x03;
const SALT_CJK_UNIGRAM = 0x04;
const SALT_SCRIPT = 0x05;
const SALT_SCRIPT_TRANS = 0x06;
const SALT_WORD_BIGRAM = 0x07;
const SALT_WORD_LEN = 0x08;

/** Words of one to three letters anchor a word bigram. */
const MAX_SHORT_WORD = 3;
const MAX_WORD_LEN_FEATURE = 20;
/** `new int[256]`: a word longer than this is cut. */
const WORD_BUFFER = 256;

// ---------------------------------------------------------------------------------------------------------------------
// ScriptCategory
// ---------------------------------------------------------------------------------------------------------------------

const LATIN = 0;
const CYRILLIC = 1;
const ARABIC = 2;
const HAN = 3;
const HANGUL = 4;
const HIRAGANA = 5;
const KATAKANA = 6;
const DEVANAGARI = 7;
const THAI = 8;
const GREEK = 9;
const HEBREW = 10;
const BENGALI = 11;
const GEORGIAN = 12;
const ARMENIAN = 13;
const ETHIOPIC = 14;
const OTHER = 15;
const CANADIAN_ABORIGINAL = 16;
const MYANMAR = 17;
const TIBETAN = 18;
const KHMER = 19;
const HAN_EXT_A = 20;
const HAN_EXT_B = 21;
const HAN_COMPAT = 22;
const BOPOMOFO = 23;
const SCRIPT_COUNT = 24;

/** The scripts `ScriptCategory.fromUnicodeScript` names; every other script is OTHER. */
const SCRIPTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\p{Script=Latin}/u, LATIN],
  [/\p{Script=Cyrillic}/u, CYRILLIC],
  [/\p{Script=Arabic}/u, ARABIC],
  [/\p{Script=Han}/u, HAN],
  [/\p{Script=Hangul}/u, HANGUL],
  [/\p{Script=Hiragana}/u, HIRAGANA],
  [/\p{Script=Katakana}/u, KATAKANA],
  [/\p{Script=Devanagari}/u, DEVANAGARI],
  [/\p{Script=Thai}/u, THAI],
  [/\p{Script=Greek}/u, GREEK],
  [/\p{Script=Hebrew}/u, HEBREW],
  [/\p{Script=Bengali}/u, BENGALI],
  [/\p{Script=Georgian}/u, GEORGIAN],
  [/\p{Script=Armenian}/u, ARMENIAN],
  [/\p{Script=Ethiopic}/u, ETHIOPIC],
  [/\p{Script=Canadian_Aboriginal}/u, CANADIAN_ABORIGINAL],
  [/\p{Script=Myanmar}/u, MYANMAR],
  [/\p{Script=Tibetan}/u, TIBETAN],
  [/\p{Script=Khmer}/u, KHMER],
];

const scriptCache = new Map<number, number>();

/** `ScriptCategory.of`: the script category of a code point (the lower-cased one, as the extractor asks). */
export function charSoupScriptOf(codePoint: number): number {
  if (codePoint < 0x80) return LATIN;
  if ((codePoint >= 0x3100 && codePoint <= 0x312f) || (codePoint >= 0x31a0 && codePoint <= 0x31bf)) return BOPOMOFO;
  const cached = scriptCache.get(codePoint);
  if (cached !== undefined) return cached;
  const character = String.fromCodePoint(codePoint);
  let category = OTHER;
  for (const [pattern, candidate] of SCRIPTS) {
    if (pattern.test(character)) {
      category = candidate === HAN ? hanSubBlock(codePoint) : candidate;
      break;
    }
  }
  // At most the code points that occur in the text, which is bounded; a hostile run of distinct ones is not allowed to grow it.
  if (scriptCache.size >= 65_536) scriptCache.clear();
  scriptCache.set(codePoint, category);
  return category;
}

function hanSubBlock(codePoint: number): number {
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return HAN_EXT_A;
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return HAN_COMPAT;
  if (codePoint >= 0x20000) return HAN_EXT_B;
  return HAN;
}

const isCjkScript = (script: number): boolean =>
  script === HAN || script === HAN_EXT_A || script === HAN_EXT_B || script === HAN_COMPAT || script === BOPOMOFO || script === HIRAGANA || script === KATAKANA;

const sameFamily = (a: number, b: number): boolean => a === b || (isCjkScript(a) && isCjkScript(b));

// ---------------------------------------------------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------------------------------------------------

const LETTER = /\p{L}/u;
const NONSPACING_MARK = /\p{Mn}/u;
const TATWEEL = 0x0640;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;

function isLetter(codePoint: number): boolean {
  if (codePoint < 0x80) return (codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a);
  return LETTER.test(String.fromCodePoint(codePoint));
}

/** `Character.toLowerCase(int)`: the simple mapping. */
function lowerCase(codePoint: number): number {
  if (codePoint < 0x80) return codePoint >= 0x41 && codePoint <= 0x5a ? codePoint + 0x20 : codePoint;
  return String.fromCodePoint(codePoint).toLowerCase().codePointAt(0)!;
}

/** `CharSoupFeatureExtractor.isTransparent`: marks, tatweel and the joiners are invisible to the n-grams. */
export function isCharSoupTransparent(codePoint: number): boolean {
  if (codePoint < 0x0300) return false;
  return codePoint === TATWEEL || codePoint === ZWNJ || codePoint === ZWJ || NONSPACING_MARK.test(String.fromCodePoint(codePoint));
}

// ---------------------------------------------------------------------------------------------------------------------
// Preprocessing: truncate, strip URLs and emails, NFC
// ---------------------------------------------------------------------------------------------------------------------

const URL_CHARS = new Uint8Array(128);
const MAIL_CHARS = new Uint8Array(128); // domain head: no '.'
const MAIL_DOT_CHARS = new Uint8Array(128); // local part and domain tail
for (let c = 0x30; c <= 0x39; c++) URL_CHARS[c] = MAIL_CHARS[c] = MAIL_DOT_CHARS[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) {
  URL_CHARS[c] = MAIL_CHARS[c] = MAIL_DOT_CHARS[c] = 1;
  const lower = c + 0x20;
  URL_CHARS[lower] = MAIL_CHARS[lower] = MAIL_DOT_CHARS[lower] = 1;
}
for (const c of "-_.?&~;+=/#") URL_CHARS[c.charCodeAt(0)] = 1;
MAIL_CHARS[0x2d] = MAIL_CHARS[0x5f] = 1;
MAIL_DOT_CHARS[0x2d] = MAIL_DOT_CHARS[0x5f] = MAIL_DOT_CHARS[0x2e] = 1;

const inClass = (table: Uint8Array, unit: number): boolean => unit < 128 && table[unit] === 1;

/** `"https?://[-_.?&~;+=/#0-9A-Za-z]{10,10000}"` replaced with " ". */
function stripUrls(text: string): string {
  const n = text.length;
  let out: string | null = null;
  let emitted = 0;
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) === 0x68 /* h */) {
      let afterScheme = -1;
      if (text.startsWith("http://", i)) afterScheme = i + 7;
      else if (text.startsWith("https://", i)) afterScheme = i + 8;
      if (afterScheme > 0) {
        const max = Math.min(n, afterScheme + 10_000);
        let k = afterScheme;
        while (k < max && inClass(URL_CHARS, text.charCodeAt(k))) k++;
        if (k - afterScheme >= 10) {
          out = (out ?? "") + text.slice(emitted, i) + " ";
          emitted = k;
          i = k;
          continue;
        }
      }
    }
    i++;
  }
  return out === null ? text : out + text.slice(emitted);
}

/** `"[-_.0-9A-Za-z]{1,100}@[-_0-9A-Za-z]{1,100}[-_.0-9A-Za-z]{1,100}"` replaced with " ", scanned around each '@'. */
function stripEmails(text: string): string {
  const n = text.length;
  let out: string | null = null;
  let emitted = 0;
  let floor = 0;
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) === 0x40 /* @ */) {
      let s = i;
      while (s > floor && i - s < 100) {
        if (inClass(MAIL_DOT_CHARS, text.charCodeAt(s - 1))) s--;
        else break;
      }
      if (s < i) {
        const m = i + 1;
        const cap2 = Math.min(n, m + 100);
        let j = m;
        while (j < cap2 && inClass(MAIL_CHARS, text.charCodeAt(j))) j++;
        let end = -1;
        if (j > m) {
          if (j < n && inClass(MAIL_DOT_CHARS, text.charCodeAt(j))) {
            const cap3 = Math.min(n, j + 100);
            let k = j;
            while (k < cap3 && inClass(MAIL_DOT_CHARS, text.charCodeAt(k))) k++;
            end = k;
          } else if (j - m >= 2) {
            end = j;
          }
        }
        if (end >= 0) {
          out = (out ?? "") + text.slice(emitted, s) + " ";
          emitted = end;
          floor = end;
          i = end;
          continue;
        }
      }
    }
    i++;
  }
  return out === null ? text : out + text.slice(emitted);
}

/** `CharSoupFeatureExtractor.preprocess`: truncate at 100,000 characters, strip URLs, then emails, then NFC-normalize. */
export function charSoupPreprocess(rawText: string): string {
  const text = rawText.length > CHARSOUP_MAX_TEXT_LENGTH ? rawText.slice(0, CHARSOUP_MAX_TEXT_LENGTH) : rawText;
  // The URL replacement is a barrier: "http://aaaaaaaaaa@bb" is not a mail match.
  return stripEmails(stripUrls(text)).normalize("NFC");
}

// ---------------------------------------------------------------------------------------------------------------------
// SaltedNgramFeatureExtractor
// ---------------------------------------------------------------------------------------------------------------------

const feedByte = (hash: number, byte: number): number => Math.imul(hash ^ (byte & 0xff), FNV_PRIME);

function feedInt(hash: number, value: number): number {
  let h = Math.imul(hash ^ (value & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((value >>> 8) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((value >>> 16) & 0xff), FNV_PRIME);
  return Math.imul(h ^ ((value >>> 24) & 0xff), FNV_PRIME);
}

/**
 * `SaltedNgramFeatureExtractor`: character bigrams, trigrams and 4-grams within words with a position salt, CJK unigrams,
 * script counts and script transitions, and (here, as the model was trained) bigrams of a word of one to three letters
 * with the word after it.
 */
export class SaltedNgramFeatureExtractor {
  readonly #numBuckets: number;
  readonly #useWordBigrams: boolean;
  readonly #useWordLength: boolean;

  constructor(numBuckets: number, useWordBigrams = false, useWordLength = false) {
    if (!(numBuckets > 0)) throw new RangeError(`numBuckets must be positive: ${numBuckets}`);
    this.#numBuckets = numBuckets;
    this.#useWordBigrams = useWordBigrams;
    this.#useWordLength = useWordLength;
  }

  get numBuckets(): number {
    return this.#numBuckets;
  }

  /** The counts of a raw text: preprocessed, then extracted. */
  extract(rawText: string): Int32Array {
    const counts = new Int32Array(this.#numBuckets);
    if (rawText.length === 0) return counts;
    this.#extractFeatures(charSoupPreprocess(rawText), counts);
    return counts;
  }

  #bucket(hash: number): number {
    return (hash & 0x7fffffff) % this.#numBuckets;
  }

  #emit(counts: Int32Array, salt: number, ...codePoints: number[]): void {
    let h = feedByte(FNV_BASIS, salt);
    for (const codePoint of codePoints) h = feedInt(h, codePoint);
    counts[this.#bucket(h)]!++;
  }

  #emitWordNgrams(counts: Int32Array, word: Int32Array, wordLen: number): void {
    const w = (index: number): number => word[index]!;
    // Bigrams
    if (wordLen === 2) {
      this.#emit(counts, SALT_FULL_WORD, w(0), w(1));
    } else if (wordLen > 2) {
      this.#emit(counts, SALT_BOW, w(0), w(1));
      for (let j = 1; j < wordLen - 2; j++) this.#emit(counts, SALT_MID, w(j), w(j + 1));
      this.#emit(counts, SALT_EOW, w(wordLen - 2), w(wordLen - 1));
    }
    // Trigrams
    if (wordLen === 3) {
      this.#emit(counts, SALT_FULL_WORD, w(0), w(1), w(2));
    } else if (wordLen > 3) {
      this.#emit(counts, SALT_BOW, w(0), w(1), w(2));
      for (let j = 1; j < wordLen - 3; j++) this.#emit(counts, SALT_MID, w(j), w(j + 1), w(j + 2));
      this.#emit(counts, SALT_EOW, w(wordLen - 3), w(wordLen - 2), w(wordLen - 1));
    }
    // 4-grams
    if (wordLen === 4) {
      this.#emit(counts, SALT_FULL_WORD, w(0), w(1), w(2), w(3));
    } else if (wordLen > 4) {
      this.#emit(counts, SALT_BOW, w(0), w(1), w(2), w(3));
      for (let j = 1; j < wordLen - 4; j++) this.#emit(counts, SALT_MID, w(j), w(j + 1), w(j + 2), w(j + 3));
      this.#emit(counts, SALT_EOW, w(wordLen - 4), w(wordLen - 3), w(wordLen - 2), w(wordLen - 1));
    }
    // One-letter words ("I", "a", "y", "à")
    if (wordLen === 1) this.#emit(counts, SALT_FULL_WORD, w(0));
  }

  #emitWordLength(counts: Int32Array, wordLen: number): void {
    if (!this.#useWordLength) return;
    let h = feedByte(FNV_BASIS, SALT_WORD_LEN);
    h = feedByte(h, Math.min(wordLen, MAX_WORD_LEN_FEATURE));
    counts[this.#bucket(h)]!++;
  }

  /** The short anchor word followed by the next word, a 0xFF byte between them. Returns the new previous word's length. */
  #saveAndEmitWordBigram(counts: Int32Array, prev: Int32Array, prevLen: number, word: Int32Array, wordLen: number): number {
    if (!this.#useWordBigrams) return 0;
    if (prevLen >= 1 && prevLen <= MAX_SHORT_WORD && wordLen > 0) {
      let h = feedByte(FNV_BASIS, SALT_WORD_BIGRAM);
      for (let j = 0; j < prevLen; j++) h = feedInt(h, prev[j]!);
      h = feedByte(h, 0xff);
      for (let j = 0; j < wordLen; j++) h = feedInt(h, word[j]!);
      counts[this.#bucket(h)]!++;
    }
    prev.set(word.subarray(0, wordLen));
    return wordLen;
  }

  #extractFeatures(text: string, counts: Int32Array): void {
    const word = new Int32Array(WORD_BUFFER);
    let wordLen = 0;
    const prevWord = new Int32Array(WORD_BUFFER);
    let prevWordLen = 0;

    let prevCp = -1;
    let prevScript = -1;
    let prevWasLetter = false;
    let prevWasCjk = false;

    const scriptCounts = new Int32Array(SCRIPT_COUNT);
    const transitionCounts = new Int32Array(SCRIPT_COUNT * SCRIPT_COUNT);
    let lastLetterScript = -1;

    const completeWord = (): void => {
      this.#emitWordNgrams(counts, word, wordLen);
      this.#emitWordLength(counts, wordLen);
      prevWordLen = this.#saveAndEmitWordBigram(counts, prevWord, prevWordLen, word, wordLen);
    };

    let i = 0;
    const length = text.length;
    while (i < length) {
      const cp = text.codePointAt(i)!;
      i += cp > 0xffff ? 2 : 1;

      if (cp >= 0x0300 && isCharSoupTransparent(cp)) continue;

      if (isLetter(cp)) {
        const lower = lowerCase(cp);
        const script = charSoupScriptOf(lower);
        const cjk = isCjkScript(script);

        scriptCounts[script]!++;
        if (lastLetterScript >= 0 && lastLetterScript !== script) transitionCounts[lastLetterScript * SCRIPT_COUNT + script]!++;
        lastLetterScript = script;

        if (prevWasLetter && !sameFamily(script, prevScript)) {
          // Script family change: flush the word
          if (!prevWasCjk && wordLen > 0) completeWord();
          wordLen = 0;
        }

        if (cjk) {
          // CJK: a unigram, and a bigram with the previous CJK character
          let h = feedByte(FNV_BASIS, SALT_CJK_UNIGRAM);
          h = feedInt(h, lower);
          counts[this.#bucket(h)]!++;
          if (prevWasCjk && prevCp >= 0) this.#emit(counts, SALT_MID, prevCp, lower);
          // Flush any non-CJK word in progress
          if (wordLen > 0 && !prevWasCjk) {
            completeWord();
            wordLen = 0;
          }
          // CJK breaks the word-bigram chain
          prevWordLen = 0;
        } else {
          if (!prevWasLetter || prevWasCjk || !sameFamily(script, prevScript)) wordLen = 0;
          if (wordLen < WORD_BUFFER) word[wordLen++] = lower;
        }

        prevCp = lower;
        prevScript = script;
        prevWasLetter = true;
        prevWasCjk = cjk;
      } else {
        // Non-letter: flush the word
        if (prevWasLetter && !prevWasCjk && wordLen > 0) {
          completeWord();
          wordLen = 0;
        }
        prevWasLetter = false;
        prevWasCjk = false;
        prevCp = -1;
      }
    }

    // Flush the final word
    if (prevWasLetter && !prevWasCjk && wordLen > 0) completeWord();

    for (let s = 0; s < SCRIPT_COUNT; s++) {
      if (scriptCounts[s]! > 0) {
        let h = feedByte(FNV_BASIS, SALT_SCRIPT);
        h = feedByte(h, s);
        counts[this.#bucket(h)]! += scriptCounts[s]!;
      }
    }
    for (let s = 0; s < SCRIPT_COUNT; s++) {
      for (let t = 0; t < SCRIPT_COUNT; t++) {
        const c = transitionCounts[s * SCRIPT_COUNT + t]!;
        if (c > 0) {
          let h = feedByte(FNV_BASIS, SALT_SCRIPT_TRANS);
          h = feedByte(h, s);
          h = feedByte(h, t);
          counts[this.#bucket(h)]! += c;
        }
      }
    }
  }
}
