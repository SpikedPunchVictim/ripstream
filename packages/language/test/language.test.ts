import assert from "node:assert/strict";
import { test } from "node:test";
import { FrancLanguageDetector } from "../src/index.ts";

test("detects common languages", () => {
  const detector = new FrancLanguageDetector();
  assert.equal(
    detector.detect("The parser extracts text and metadata from documents, and the test suite verifies that each format is handled correctly across many different inputs.").language,
    "eng",
  );
  assert.equal(
    detector.detect("Ceci est une phrase française sur les documents.").language,
    "fra",
  );
  assert.equal(detector.detect("hi").language, "und");
});

test("streaming detector updates from buffered text", async () => {
  const { StreamingLanguageDetector } = await import("../src/index.ts");
  const streaming = new StreamingLanguageDetector(new FrancLanguageDetector());
  await streaming.feed("The parser extracts text and metadata from documents, ");
  const result = await streaming.feed(
    "and the test suite verifies each format across many different inputs.",
  );
  assert.equal(result.language, "eng");
  streaming.reset();
  assert.equal(streaming.result.language, "und");
});

test("language quality sample set is reasonably certain", async () => {
  const detector = new (await import("../src/index.ts")).FrancLanguageDetector();
  const samples: Array<[string, string]> = [
    ["eng", "The parser extracts text and metadata from documents, and the test suite verifies each format across many different inputs."],
    ["fra", "Le analyseur extrait le texte et les métadonnées des documents, et la suite de tests vérifie chaque format avec de nombreuses entrées différentes."],
    ["deu", "Der Parser extrahiert Text und Metadaten aus Dokumenten, und die Testsuite prüft jedes Format mit vielen verschiedenen Eingaben."],
  ];
  for (const [language, text] of samples) {
    const result = detector.detect(text);
    assert.equal(result.language, language);
    assert.ok(result.isReasonablyCertain);
  }
});
