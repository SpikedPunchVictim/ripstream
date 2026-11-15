import assert from "node:assert/strict";
import { test } from "node:test";
import { detectEncoding, isBinaryBytes, looksLikeText } from "../src/text-encoding.ts";

// A fixed-seed generator, so a failure replays.
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The control-byte rule as it was written before the loop was indexed: no NUL, at most 2% other control bytes. */
function referenceControlRule(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  let control = 0;
  let nul = 0;
  for (const byte of data) {
    if (byte === 0) nul++;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b) control++;
  }
  return nul > 0 || control / data.length > 0.02;
}

function build(parts: Array<number[] | Uint8Array>): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

function structuredCorpus(): Uint8Array[] {
  const text = ascii("The quick brown fox jumps over the lazy dog.\n".repeat(20));
  const corpus: Uint8Array[] = [];
  corpus.push(new Uint8Array(0), new Uint8Array([0]), new Uint8Array([0x1b]), new Uint8Array([0x0c]), new Uint8Array([0x41]));
  // The BOMs, alone, before text and before binary-looking bytes.
  for (const bom of [[0, 0, 0xfe, 0xff], [0xff, 0xfe, 0, 0], [0xef, 0xbb, 0xbf], [0xfe, 0xff], [0xff, 0xfe]]) {
    corpus.push(build([bom]), build([bom, text]), build([bom, [0, 1, 2, 3, 4, 5, 6, 7, 0, 0]]));
  }
  // ESC and form feed are not control bytes for the rule: a page full of them is text, a few other controls are not.
  corpus.push(build([text, new Array(200).fill(0x1b)]), build([text, new Array(200).fill(0x0c)]));
  corpus.push(build([text, new Array(200).fill(0x01)]), build([text, [0x01]]), build([text, [0x00]]));
  // ISO-2022 text: 7-bit with ESC designations.
  corpus.push(build([ascii("abc "), [0x1b], ascii("$B"), [0x30, 0x21, 0x30, 0x22], [0x1b], ascii("(B def\n")]));
  corpus.push(build([ascii("abc "), [0x1b], ascii("$)C"), [0x0e, 0x30, 0x21, 0x0f], ascii(" def\n")]));
  // UTF-16 without a BOM, both orders, short and long, and one that is NUL-heavy but not UTF-16.
  const utf16le = (value: string): number[] => [...value].flatMap((char) => [char.charCodeAt(0), 0]);
  const utf16be = (value: string): number[] => [...value].flatMap((char) => [0, char.charCodeAt(0)]);
  corpus.push(build([utf16le("hello world, this is text")]), build([utf16be("hello world, this is text")]));
  corpus.push(build([utf16le("abc")]), build([utf16be("abc")]), build([utf16le("a".repeat(600))]), build([utf16be("a".repeat(600))]));
  corpus.push(build([new Array(64).fill(0)]), build([text, new Array(300).fill(0)]));
  // A control-byte ratio on both sides of the 2% threshold (50 bytes: 1 control is exactly 2%, 2 are over).
  const fifty = ascii("x".repeat(50));
  corpus.push(build([fifty.slice(1), [0x01]]), build([fifty.slice(2), [0x01, 0x02]]));
  corpus.push(build([ascii("x".repeat(99)), [0x01]]), build([ascii("x".repeat(97)), [0x01, 0x02, 0x03]]));
  // Latin-1, UTF-8 and Shift_JIS text.
  corpus.push(build([ascii("caf"), [0xe9], ascii(" cr"), [0xe8], ascii("me\n")]), new TextEncoder().encode("héllo wörld ✓\n"));
  corpus.push(Uint8Array.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]));
  return corpus;
}

test("isBinaryBytes equals detectEncoding().binary over a structured corpus (BOMs, ESC, form feed, ISO-2022, UTF-16/32)", () => {
  for (const [index, data] of structuredCorpus().entries()) {
    assert.equal(isBinaryBytes(data), detectEncoding(data).binary, `case ${index}: ${Buffer.from(data).toString("hex").slice(0, 60)}`);
  }
});

test("isBinaryBytes equals detectEncoding().binary over random buffers of every byte value", () => {
  const next = lcg(20240607);
  for (let round = 0; round < 1500; round++) {
    const length = Math.floor(next() * (round % 10 === 0 ? 3000 : 120));
    const data = new Uint8Array(length);
    // Mix the byte ranges so the corpus lands on both sides of every rule: mostly text, some control, some NUL, some high.
    const controlRate = next() * 0.06;
    const nulRate = next() < 0.3 ? next() * 0.7 : 0;
    const highRate = next() < 0.5 ? 0 : next();
    for (let index = 0; index < length; index++) {
      const roll = next();
      if (roll < nulRate) data[index] = 0;
      else if (roll < nulRate + controlRate) data[index] = Math.floor(next() * 0x20);
      else if (next() < highRate) data[index] = 0x80 + Math.floor(next() * 0x80);
      else data[index] = 0x20 + Math.floor(next() * 0x5f);
    }
    if (round % 7 === 0 && length > 4) data.set([[0xef, 0xbb, 0xbf], [0xff, 0xfe, 0], [0xfe, 0xff, 0], [0, 0, 0xfe, 0xff]][round % 4]!);
    assert.equal(isBinaryBytes(data), detectEncoding(data).binary, `round ${round}`);
  }
});

test("isBinaryBytes equals detectEncoding().binary over fully random bytes", () => {
  const next = lcg(99);
  for (let round = 0; round < 500; round++) {
    const data = Uint8Array.from({ length: Math.floor(next() * 400) }, () => Math.floor(next() * 256));
    assert.equal(isBinaryBytes(data), detectEncoding(data).binary, `round ${round}`);
  }
});

test("looksLikeText is the control-byte rule as it was written with for...of", () => {
  const next = lcg(7);
  for (let round = 0; round < 1000; round++) {
    const data = Uint8Array.from({ length: Math.floor(next() * 200) }, () => (next() < 0.9 ? 0x41 + Math.floor(next() * 20) : Math.floor(next() * 0x30)));
    assert.equal(!looksLikeText(data), referenceControlRule(data), `round ${round}`);
  }
});

test("a subarray view is judged by its own bytes", () => {
  const backing = build([[0, 0, 0, 0], ascii("plain text here"), [0, 0, 0, 0]]);
  assert.equal(isBinaryBytes(backing.subarray(4, 4 + 15)), false);
  assert.equal(isBinaryBytes(backing), true);
});
