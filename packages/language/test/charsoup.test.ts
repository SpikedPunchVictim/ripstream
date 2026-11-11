import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CharSoupLanguageDetector, CHARSOUP_MODEL_FILE } from "../src/charsoup.ts";
import { CharSoupModel } from "../src/charsoup-model.ts";

/*
 * The 20 sentences of Apache Tika 4.2.0's LangIdRegressionTest (tika-langdetect-charsoup): each must come back as the
 * language Tika's test expects, with a raw score of at least 0.5. The model was trained on the exact pipeline the
 * detector ports, so a feature that is hashed differently, or logits that are computed differently, fail most of them.
 */
const REGRESSION: ReadonlyArray<readonly [string, string]> = [
  ["eng", "Scientists have discovered a new species of butterfly in the tropical rainforests of South America."],
  ["deu", "Der Deutsche Bundestag ist das Parlament der Bundesrepublik Deutschland und besteht aus direkt gewählten Abgeordneten."],
  ["fra", "La République française est une démocratie laïque dont la devise est Liberté, Égalité, Fraternité."],
  ["spa", "El español es una lengua romance procedente del latín vulgar hablada principalmente en España y en América Latina."],
  ["por", "A língua portuguesa é uma língua indo-europeia românica falada principalmente em Portugal e no Brasil."],
  ["ita", "La lingua italiana è una lingua romanza parlata principalmente in Italia e in alcune regioni limitrofe."],
  ["nld", "Het Nederlands is een West-Germaanse taal die in Nederland, België en Suriname als officiële taal wordt gebruikt."],
  ["pol", "Język polski jest językiem z grupy słowiańskiej i należy do rodziny indoeuropejskiej, urzędowym językiem Polski."],
  ["swe", "Svenska är ett östnordiskt språk som talas av ungefär tio miljoner personer, främst i Sverige och Finland."],
  ["tur", "Türkçe, Türk dil ailesinin Oğuz grubuna ait bir dil olup ağırlıklı olarak Türkiye'de konuşulmaktadır."],
  ["fin", "Suomi on uralilainen kieli, jota puhutaan pääasiassa Suomessa ja joka on maan virallinen kieli."],
  ["rus", "Российская Федерация — государство в Восточной Европе и Северной Азии, занимающее первое место в мире по территории."],
  ["ukr", "Українська мова є слов'янською мовою і є офіційною мовою України, однією з найпоширеніших мов в Європі."],
  ["bul", "Българският език е индоевропейски език от групата на южнославянските езици и е официален език на Република България."],
  ["ara", "اللغة العربية إحدى اللغات السامية، وهي أكثر اللغات انتشاراً وتحدثاً في العالم العربي والشرق الأوسط."],
  ["fas", "زبان فارسی یکی از زبان‌های هندواروپایی است که در ایران، افغانستان و تاجیکستان به عنوان زبان رسمی استفاده می‌شود."],
  ["zho", "中华人民共和国位于亚洲东部，是世界上人口最多的国家，也是世界第二大经济体。"],
  ["jpn", "日本語は日本国の公用語として広く使用されており、約一億三千万人の話者がいる言語である。"],
  ["kor", "한국어는 대한민국과 조선민주주의인민공화국의 공용어이며 약 칠천오백만 명이 사용한다."],
  ["hin", "हिन्दी भारत की राजभाषा है और भारत में सबसे अधिक बोली जाने वाली भाषाओं में से एक है।"],
  ["ben", "বাংলা ভাষা বাংলাদেশের রাষ্ট্রভাষা এবং ভারতের পশ্চিমবঙ্গ রাজ্যের সরকারি ভাষা।"],
  ["ell", "Η ελληνική γλώσσα είναι μια από τις πιο παλιές γλώσσες στον κόσμο και η επίσημη γλώσσα της Ελλάδας και της Κύπρου."],
];

const detector = new CharSoupLanguageDetector();

for (const [language, text] of REGRESSION) {
  test(`Tika's regression sentence: ${language}`, () => {
    const result = detector.identify(text);
    assert.equal(result.language, language, `score ${result.rawScore}`);
    assert.ok(result.rawScore >= 0.5, `score ${result.rawScore} is below 0.5`);
  });
}

test("the model is Tika's, byte for byte, and has the 204 languages Tika documents", () => {
  const bytes = readFileSync(CHARSOUP_MODEL_FILE);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "376e33f4d36c6ae2924079342cdd6678971dc4ca381a51164b8dc4a73483c8a0");
  const model = CharSoupModel.load(new Uint8Array(bytes));
  assert.equal(model.numClasses, 204);
  assert.equal(model.numBuckets, 32768);
  assert.equal(model.featureFlags, 0xe81);
  assert.ok(model.labels.includes("eng") && model.labels.includes("be-x-old") && model.labels.includes("cdo-x-rom"));
  assert.equal(CharSoupLanguageDetector.supportedLanguages.size, 204);
});

test("a model that is not one is refused, and says why", () => {
  assert.throws(() => CharSoupModel.load(new Uint8Array(32)), /magic/i);
  const bytes = new Uint8Array(readFileSync(CHARSOUP_MODEL_FILE));
  const wrongVersion = bytes.slice();
  wrongVersion[7] = 9;
  assert.throws(() => CharSoupModel.load(wrongVersion), /version/i);
  assert.throws(() => CharSoupModel.load(bytes.subarray(0, 1000)), /truncated|short|ends/i);
});

test("a clear sentence is HIGH, with a raw score that is a 32-bit float", () => {
  const result = detector.identify(REGRESSION[0]![1]);
  assert.equal(result.confidence, "HIGH");
  assert.ok(result.rawScore > 0.9 && result.rawScore <= 1);
  assert.equal(Math.fround(result.rawScore), result.rawScore);
});

test("blank text is Tika's NULL result: no language, NONE, 0", () => {
  const none = { language: "", confidence: "NONE", rawScore: 0 };
  assert.deepEqual(detector.identify(""), none);
  assert.deepEqual(detector.identify(" \n\t "), none);
  assert.deepEqual(detector.identify(" 　"), none);
});

test("maxLength keeps the first characters and ignores the rest, as Tika's addText does", () => {
  const english = REGRESSION[0]![1];
  const french = REGRESSION[2]![1].repeat(40);
  assert.equal(detector.identify(english + " " + french, { maxLength: english.length }).language, "eng");
  assert.deepEqual(detector.identify(english, { maxLength: 0 }), { language: "", confidence: "NONE", rawScore: 0 });
  assert.deepEqual(detector.identify(english, { maxLength: -5 }), { language: "", confidence: "NONE", rawScore: 0 });
});

test("without a maxLength the detector reads the first 100,000 characters", () => {
  const english = REGRESSION[0]![1] + " ";
  const text = english.repeat(Math.ceil(100_000 / english.length)).slice(0, 100_000) + "x".repeat(50_000);
  assert.equal(detector.identify(text).language, "eng");
});

test("confusable languages are scored as the group: Indonesian text is confidently Indonesian or Malay", () => {
  const result = detector.identify(
    "Bahasa Indonesia adalah bahasa resmi Republik Indonesia dan bahasa persatuan bangsa yang digunakan oleh jutaan orang di seluruh nusantara.",
  );
  assert.ok(result.language === "ind" || result.language === "msa", result.language);
  assert.equal(result.confidence, "HIGH");
});

test("Cantonese and Mandarin are one group: Han text is confidently one of them", () => {
  const result = detector.identify("中华人民共和国位于亚洲东部，是世界上人口最多的国家，也是世界第二大经济体。");
  assert.ok(result.language === "zho" || result.language === "yue");
  assert.equal(result.confidence, "HIGH");
});

test("the feature vector is L2-normalized: saying the same thing twice scores the same", () => {
  // Short texts are far from saturated, so the score moves with the scale of the features, if they are not normalized.
  for (const text of ["Hello world", "Bonjour tout le monde", "ciao come stai"]) {
    const once = detector.identify(text);
    const twice = detector.identify(`${text}. ${text}`);
    assert.equal(twice.language, once.language);
    assert.ok(Math.abs(twice.rawScore - once.rawScore) < 1e-5, `${text}: ${once.rawScore} vs ${twice.rawScore}`);
    assert.ok(once.rawScore < 0.99, `${text} is not saturated`);
  }
});

test("the answer does not depend on the whitespace around the text", () => {
  const text = REGRESSION[1]![1];
  assert.deepEqual(detector.identify(`  \n${text}\n\n `), detector.identify(text));
});

test("detect is the SPI's answer: ISO 639-3, the raw score as confidence, 'und' when nothing was found", () => {
  const english = detector.detect(REGRESSION[0]![1]);
  assert.equal(english.language, "eng");
  assert.equal(english.isReasonablyCertain, true);
  assert.ok(english.confidence > 0.9);
  assert.deepEqual(detector.detect("   "), { language: "und", confidence: 0, isReasonablyCertain: false });
});

test("an unreadable URL or address in the text does not change the answer", () => {
  const text = REGRESSION[2]![1];
  assert.equal(detector.identify(`${text} https://example.org/some/long/path?x=1#y write to jean.dupont@exemple.fr`).language, "fra");
});
