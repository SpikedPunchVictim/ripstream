import assert from "node:assert/strict";
import { test } from "node:test";
import { toIso6391 } from "../src/iso639.ts";

test("a language with a two-letter code is named by it", () => {
  assert.equal(toIso6391("eng"), "en");
  assert.equal(toIso6391("deu"), "de");
  assert.equal(toIso6391("fra"), "fr");
  assert.equal(toIso6391("zho"), "zh");
});

test("an individual language of a macrolanguage is named by the macrolanguage's code", () => {
  assert.equal(toIso6391("arb"), "ar");
  assert.equal(toIso6391("cmn"), "zh");
  assert.equal(toIso6391("pes"), "fa");
});

test("a language with no two-letter code, and an undetermined one, keep what they are", () => {
  assert.equal(toIso6391("ceb"), "ceb");
  assert.equal(toIso6391("und"), "und");
  assert.equal(toIso6391(""), "");
  assert.equal(toIso6391("en"), "en");
});

test("the table agrees with the ICU names for every pair", () => {
  // `Intl.DisplayNames` folds a three-letter code into its two-letter one, so the two name the same language.
  const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });
  for (const three of ["eng", "deu", "spa", "rus", "jpn", "kor", "ara", "heb", "ind", "nob", "swa", "zul", "isl", "cym", "mya"]) {
    const two = toIso6391(three);
    assert.notEqual(two, three, three);
    assert.equal(names.of(two), names.of(three), three);
  }
});
