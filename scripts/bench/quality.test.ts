// Cases ported from xberg tools/benchmark-harness/src/quality/tests.rs (MIT), so the TS
// port scores exactly as the harness does. Run: node --test scripts/bench/quality.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeF1, computeQuality, formatRustFloat, tokenize } from "./quality.ts";

describe("tokenize", () => {
  it("strips punctuation, lowercases and normalises numbers", () => {
    assert.deepEqual(tokenize("Hello, world! 15.0"), ["hello", "world", "15"]);
    assert.deepEqual(tokenize("100.00"), ["100"]);
  });

  it("keeps decimals and European decimal commas", () => {
    assert.deepEqual(tokenize("3.14 0.5 12.345 3,14"), ["3.14", "0.5", "12.345", "3,14"]);
  });

  it("removes thousands separators", () => {
    assert.deepEqual(tokenize("1,000"), tokenize("1000"));
    assert.deepEqual(tokenize("12,345,678"), tokenize("12345678"));
    assert.deepEqual(tokenize("1,234.56"), tokenize("1234.56"));
  });

  it("leaves numbers with more than 15 digits untouched", () => {
    assert.deepEqual(tokenize("10000000000000001"), ["10000000000000001"]);
    assert.deepEqual(tokenize("12345678901234.0"), ["12345678901234"]);
  });

  it("applies NFKC and drops invisible characters", () => {
    assert.deepEqual(tokenize("１２３"), ["123"]);
    assert.deepEqual(tokenize("ﬁle"), ["file"]);
    assert.deepEqual(tokenize("exam­ple"), ["example"]);
  });

  it("reduces markdown links to their text and drops bare URLs", () => {
    assert.deepEqual(tokenize("See [docs](https://example.com/docs) for details"), ["see", "docs", "for", "details"]);
    assert.deepEqual(tokenize("![alt text](https://example.com/image.png)"), ["alt", "text"]);
    assert.deepEqual(tokenize("See https://example.com for details"), ["see", "for", "details"]);
    assert.deepEqual(tokenize("Visit www.example.com today"), ["visit", "today"]);
  });

  it("treats a pipe as a separator", () => {
    assert.deepEqual(tokenize("|a|b|"), ["a", "b"]);
  });

  it("expands CJK runs into bigrams within one whitespace token", () => {
    assert.deepEqual(tokenize("日本語"), ["日本", "本語"]);
    assert.deepEqual(tokenize("日"), ["日"]);
    assert.deepEqual(tokenize("日本\n語の\n文書"), ["日本", "語の", "文書"]);
    assert.deepEqual(tokenize("日本,語"), tokenize("日本語"));
    assert.deepEqual(tokenize("日本語HS令和5年"), ["日本", "本語", "hs", "令和", "5", "年"]);
    assert.deepEqual(tokenize("時々刻々"), ["時々", "々刻", "刻々"]);
  });
});

describe("formatRustFloat", () => {
  it("never uses exponent notation", () => {
    assert.equal(formatRustFloat(1e21), "1000000000000000000000");
    assert.equal(formatRustFloat(1.5e-7), "0.00000015");
    assert.equal(formatRustFloat(0.5), "0.5");
  });
});

describe("computeQuality", () => {
  it("scores identical text 1", () => {
    assert.equal(computeQuality("Hello world this is a test", "Hello world this is a test").quality, 1);
  });

  it("scores partial overlap 2/3 without numeric weighting", () => {
    const result = computeQuality("hello world foo", "hello world bar");
    assert.ok(Math.abs(result.f1Text - 2 / 3) < 1e-9);
    assert.equal(result.quality, result.f1Text);
  });

  it("ignores a stray extracted digit when the ground truth has no numbers", () => {
    const result = computeQuality("revenue grew significantly year over year Page 3", "revenue grew significantly year over year");
    assert.equal(result.f1Text, 0.8571428571428571);
    assert.equal(result.quality, result.f1Text);
  });

  it("charges 40% when ground-truth numbers are dropped", () => {
    const result = computeQuality("revenue was million dollars", "revenue was 42 million dollars");
    assert.equal(result.f1Numeric, 0);
    assert.equal(result.quality, 0.6 * result.f1Text);
  });

  it("matches the harness on reordered Japanese OCR lines", () => {
    const truth =
      "元来日本語は漢文に倣い、文字を上から下へ、また行を右から左へと進めて表記を行っていた。漢字と仮名の筆順も縦書きを前提としており、横書き不能な書体も存在する。";
    const extracted =
      "から下へまた行を右から左へと進\nの筆順も縦書きを前提としており、\nめて表記を行っていた。漢字と仮名\n横書き不能な書体も存在する。\n元来日本語は漢文に倣い、文字を上";
    assert.equal(computeQuality(extracted, truth).f1Text, 0.9714285714285714);
    assert.equal(computeQuality("日本\n語の\n文書", "日本語の文書").f1Text, 0.7499999999999999);
  });

  it("returns 1 for two empty sides and 0 for one", () => {
    assert.equal(computeF1([], []), 1);
    assert.equal(computeF1([], ["a"]), 0);
  });
});
