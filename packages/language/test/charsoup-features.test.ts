import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHARSOUP_NUM_BUCKETS,
  SaltedNgramFeatureExtractor,
  charSoupPreprocess,
  charSoupScriptOf,
  isCharSoupTransparent,
} from "../src/charsoup-features.ts";

/*
 * Ported from Apache Tika 4.2.0's CharSoupFeatureExtractorTest: the model was trained on this exact preprocessing, so
 * the URL and email scanners must stay identical to the regexes they replaced, and the features must be the ones the
 * model's weights belong to.
 */

const GREEDY_URL = /https?:\/\/[-_.?&~;+=/#0-9A-Za-z]{10,10000}/g;
const GREEDY_MAIL = /[-_.0-9A-Za-z]{1,100}@[-_0-9A-Za-z]{1,100}[-_.0-9A-Za-z]{1,100}/g;
const reference = (text: string): string => text.replace(GREEDY_URL, " ").replace(GREEDY_MAIL, " ");

const FIXED_CASES = [
  "a@bb",
  "a@b",
  "a@.b",
  "a@b..c",
  "a@" + "b".repeat(250),
  "a".repeat(150) + "@x.y",
  "a".repeat(200) + "@",
  "local@local@local",
  "x@y.z a@bb user@example.com",
  "@@@@@@",
  "a@a@a@a@a@a@",
  "a@" + "b".repeat(100) + "." + "c".repeat(150),
  "a@" + "b".repeat(99) + "." + "c".repeat(99),
  "a@" + "b".repeat(300),
  "aa@bb cc@dd ee@ff",
  "a@bb@cc@dd",
  "http://" + "a".repeat(9),
  "http://" + "a".repeat(10),
  "https://" + "a".repeat(10000),
  "https://" + "a".repeat(10001),
  "https://" + "a".repeat(10005) + "@bb",
  "http://http://aaaaaaaaaa",
  "http://aaaahttp://bbbbbbbbbb",
  "hhttp://aaaaaaaaaaa",
  "http:/notaurl http//nope https:/x",
  "http://aaaaaaaaaa@bb",
  "a@http://aaaaaaaaaa",
  "a@httpx.y",
  "user@example.com/http://foobarbazqux",
  "é@bb",
  "aé@bb",
  "a@büc.d",
  "http://aéaaaaaaaaaa",
  "see http://example.com/a/b?q=1#f and mail bob.smith@sub-domain_x.example.org.",
];

/** A small seeded generator, so a failure names the seed that reproduces it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("URL and email stripping is the greedy regexes' answer on Tika's cases", () => {
  for (const text of FIXED_CASES) assert.equal(charSoupPreprocess(text), reference(text), `input=${text.slice(0, 80)}`);
});

test("URL and email stripping is the greedy regexes' answer on random inputs (seeded)", () => {
  const seed = 20260320;
  const next = random(seed);
  const atoms = ["a", "B", "9", ".", "-", "_", "@", ":", "/", "#", "?", "=", " ", "http://", "https://", "http", "://", "@a.", "é", "aaaaaaaaaa"];
  const pick = (): string => atoms[Math.floor(next() * atoms.length)]!;
  for (let i = 0; i < 5000; i++) {
    const length = 1 + Math.floor(next() * 60);
    let text = "";
    for (let j = 0; j < length; j++) text += pick();
    assert.equal(charSoupPreprocess(text), reference(text), `seed=${seed} input=${text}`);
  }
  for (let i = 0; i < 50; i++) {
    let text = "";
    while (text.length < 3000) text += "a".repeat(1 + Math.floor(next() * 400)) + pick();
    assert.equal(charSoupPreprocess(text), reference(text), `seed=${seed} long input #${i}`);
  }
});

test("preprocessing truncates at 100,000 characters before it strips anything", () => {
  assert.equal(charSoupPreprocess("x".repeat(100_005)).length, 100_000);
  // A URL that straddles the cut is cut with it: what is left of it is shorter than the ten characters a URL needs.
  const cut = "y".repeat(99_995) + "http://abcdefghijklmnop";
  assert.equal(charSoupPreprocess(cut), "y".repeat(99_995) + "http:");
});

test("preprocessing NFC-normalizes: é composed and decomposed are one text", () => {
  assert.equal(charSoupPreprocess("é"), "é");
});

test("isTransparent: marks, tatweel and the joiners are skipped; letters and ASCII are not", () => {
  for (const cp of [0x064e, 0x0651, 0x0670, 0x05b0, 0x05c7, 0x0300, 0x0640, 0x200c, 0x200d]) {
    assert.equal(isCharSoupTransparent(cp), true, cp.toString(16));
  }
  for (const cp of [0x41, 0x7a, 0x00e9, 0x0627, 0x05d0, 0x4e2d, 0x200b, 0x2060]) {
    assert.equal(isCharSoupTransparent(cp), false, cp.toString(16));
  }
});

test("scripts: the categories the model's script features are keyed by", () => {
  const expectations: Array<[string, number, number]> = [
    ["a", 0x61, 0],
    ["é", 0xe9, 0],
    ["ж", 0x436, 1],
    ["ع", 0x639, 2],
    ["中", 0x4e2d, 3],
    ["한", 0xd55c, 4],
    ["ひ", 0x3072, 5],
    ["カ", 0x30ab, 6],
    ["ह", 0x939, 7],
    ["ก", 0xe01, 8],
    ["λ", 0x3bb, 9],
    ["א", 0x5d0, 10],
    ["ব", 0x9ac, 11],
    ["ა", 0x10d0, 12],
    ["ա", 0x561, 13],
    ["አ", 0x12a0, 14],
    ["\u{1d400}", 0x1d400, 15],
    ["ᐊ", 0x140a, 16],
    ["က", 0x1000, 17],
    ["ཀ", 0xf40, 18],
    ["ក", 0x1780, 19],
    ["㐀", 0x3400, 20],
    ["\u{20000}", 0x20000, 21],
    ["豈", 0xf900, 22],
    ["ㄅ", 0x3105, 23],
  ];
  for (const [label, cp, category] of expectations) assert.equal(charSoupScriptOf(cp), category, `${label} U+${cp.toString(16)}`);
});

/** The independent half of the hash: FNV-1a over bytes, in BigInt, so nothing here shares a line with the extractor. */
function fnv(bytes: number[]): number {
  let hash = 0x811c9dc5n;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x01000193n) & 0xffffffffn;
  return Number(hash);
}
const word = (salt: number, ...codePoints: number[]): number[] => [salt, ...codePoints.flatMap((cp) => [cp & 0xff, (cp >>> 8) & 0xff, (cp >>> 16) & 0xff, (cp >>> 24) & 0xff])];
const bucketOf = (bytes: number[]): number => (fnv(bytes) & 0x7fffffff) % CHARSOUP_NUM_BUCKETS;
const scriptBucket = (script: number, count: number): [number, number] => [bucketOf([5, script]), count];

function features(text: string): Map<number, number> {
  const counts = new SaltedNgramFeatureExtractor(CHARSOUP_NUM_BUCKETS, true).extract(text);
  const found = new Map<number, number>();
  counts.forEach((count, bucket) => {
    if (count !== 0) found.set(bucket, count);
  });
  return found;
}

function expected(...pairs: Array<[number, number]>): Map<number, number> {
  const map = new Map<number, number>();
  for (const [bucket, count] of pairs) map.set(bucket, (map.get(bucket) ?? 0) + count);
  return map;
}

const A = 0x61;
const B = 0x62;
const C = 0x63;
const D = 0x64;
const E = 0x65;

test("a two-letter word is one FULL_WORD bigram and the script count", () => {
  assert.deepEqual(features("ab"), expected([bucketOf(word(3, A, B)), 1], scriptBucket(0, 2)));
});

test("a one-letter word is one FULL_WORD unigram", () => {
  assert.deepEqual(features("a"), expected([bucketOf(word(3, A)), 1], scriptBucket(0, 1)));
});

test("a five-letter word has BOW, MID and EOW n-grams of orders 2, 3 and 4", () => {
  const expectedFeatures = expected(
    // bigrams: BOW ab, MID bc, MID cd, EOW de
    [bucketOf(word(1, A, B)), 1],
    [bucketOf(word(0, B, C)), 1],
    [bucketOf(word(0, C, D)), 1],
    [bucketOf(word(2, D, E)), 1],
    // trigrams: BOW abc, MID bcd, EOW cde
    [bucketOf(word(1, A, B, C)), 1],
    [bucketOf(word(0, B, C, D)), 1],
    [bucketOf(word(2, C, D, E)), 1],
    // 4-grams: BOW abcd, EOW bcde
    [bucketOf(word(1, A, B, C, D)), 1],
    [bucketOf(word(2, B, C, D, E)), 1],
    scriptBucket(0, 5),
  );
  assert.deepEqual(features("abcde"), expectedFeatures);
});

test("a word bigram is emitted when the word before is one to three letters long", () => {
  // "ab" then "cd": the bigram of "ab" followed by "cd", with the 0xFF separator between them.
  const bigram = [7, A, 0, 0, 0, B, 0, 0, 0, 0xff, C, 0, 0, 0, D, 0, 0, 0];
  const found = features("ab cd");
  assert.equal(found.get(bucketOf(bigram)), 1);
  // A three-letter word anchors too: "abc" then "de".
  const threeLetterAnchor = [7, A, 0, 0, 0, B, 0, 0, 0, C, 0, 0, 0, 0xff, D, 0, 0, 0, E, 0, 0, 0];
  assert.equal(features("abc de").get(bucketOf(threeLetterAnchor)), 1);
  // "abcd ef": the first word is four letters, too long to anchor a bigram.
  const noAnchor = [7, A, 0, 0, 0, B, 0, 0, 0, C, 0, 0, 0, D, 0, 0, 0, 0xff, E, 0, 0, 0, 0x66, 0, 0, 0];
  assert.equal(features("abcd ef").get(bucketOf(noAnchor)), undefined);
});

test("case is folded, and a letter's marks are skipped", () => {
  assert.deepEqual(features("AB"), features("ab"));
  // Arabic: a fatha between the letters changes nothing.
  assert.deepEqual(features("كتب"), features("كَتَب"));
});

test("CJK characters are unigrams and neighbours form bigrams, with no word", () => {
  const found = features("中文");
  assert.equal(found.get(bucketOf(word(4, 0x4e2d))), 1);
  assert.equal(found.get(bucketOf(word(4, 0x6587))), 1);
  assert.equal(found.get(bucketOf(word(0, 0x4e2d, 0x6587))), 1);
  assert.equal(found.get(bucketOf([5, 3])), 2);
});

test("a script change is a transition, counted", () => {
  const found = features("ab жз");
  assert.equal(found.get(bucketOf([6, 0, 1])), 1);
});

test("no letters, no features; a supplementary letter is one code point", () => {
  assert.equal(features("123 !?").size, 0);
  assert.equal(features("").size, 0);
  const found = features("\u{1d400}");
  assert.equal([...found.values()].reduce((sum, count) => sum + count, 0), 2);
});

test("a word is cut at 256 code points, as Tika's buffer is", () => {
  const long = "a".repeat(300);
  const found = features(long);
  // The first, middle and last n-grams of a 256-letter word: 255 + 254 + 253 bigram, trigram and 4-gram features, plus the script count.
  let total = 0;
  for (const count of found.values()) total += count;
  assert.equal(total, 255 + 254 + 253 + 300);
});
