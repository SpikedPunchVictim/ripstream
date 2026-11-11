import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LanguageDetectionMetadataFilter,
  Metadata,
  ParseContext,
  TIKA_KEYS,
  type LanguageIdentification,
  type LanguageIdentifier,
} from "../src/index.ts";

/*
 * Tika 4.2.0's CharSoupMetadataFilter: from `tk:content` it writes `tk:detected-language`, `tk:detected-language-confidence`
 * (the confidence's enum name) and `tk:detected-language-confidence-raw` (the score, as `Double.toString` writes it). It
 * does nothing for a document with no content, which Tika says "reads as no language found rather than never ran".
 */

interface Call {
  readonly text: string;
  readonly maxLength: number | undefined;
}

/** An identifier that answers `answers` in turn (the last one for ever after) and records what it was asked. */
function identifier(...answers: LanguageIdentification[]): LanguageIdentifier & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    identify(text, options) {
      calls.push({ text, maxLength: options?.maxLength });
      return answers[Math.min(calls.length, answers.length) - 1]!;
    },
  };
}

const ENGLISH: LanguageIdentification = { language: "eng", confidence: "HIGH", rawScore: Math.fround(0.9) };
const NOTHING: LanguageIdentification = { language: "", confidence: "NONE", rawScore: 0 };

function document(fields: Readonly<Record<string, string>>): Metadata {
  const metadata = new Metadata();
  for (const [name, value] of Object.entries(fields)) metadata.add(name, value);
  return metadata;
}

function run(filter: LanguageDetectionMetadataFilter, ...list: Metadata[]): void {
  filter.filter(list, new ParseContext());
}

test("the three keys are Tika's", () => {
  assert.equal(TIKA_KEYS.DETECTED_LANGUAGE, "tk:detected-language");
  assert.equal(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE, "tk:detected-language-confidence");
  assert.equal(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE_RAW, "tk:detected-language-confidence-raw");
});

test("the language, the confidence's name and the score as Double.toString writes it are set from tk:content", () => {
  const source = identifier(ENGLISH);
  const metadata = document({ [TIKA_KEYS.CONTENT]: "Hello there" });
  run(new LanguageDetectionMetadataFilter({ identifier: source }), metadata);
  assert.deepEqual(source.calls, [{ text: "Hello there", maxLength: undefined }]);
  assert.equal(metadata.get(TIKA_KEYS.DETECTED_LANGUAGE), "eng");
  assert.equal(metadata.get(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE), "HIGH");
  // (double) 0.9f, the float the detector answers with, widened: Java does not shorten it to 0.9.
  assert.equal(metadata.get(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE_RAW), "0.8999999761581421");
});

test("no language found is written, not left out: an empty language, NONE and 0.0", () => {
  const metadata = document({ [TIKA_KEYS.CONTENT]: "12345" });
  run(new LanguageDetectionMetadataFilter({ identifier: identifier(NOTHING) }), metadata);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.DETECTED_LANGUAGE), [""]);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE), ["NONE"]);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE_RAW), ["0.0"]);
});

test("a document with no tk:content, or an empty one, is left as it is and the identifier is not asked", () => {
  const source = identifier(ENGLISH);
  const none = document({ "dc:title": "x" });
  const empty = document({ [TIKA_KEYS.CONTENT]: "", "dc:title": "y" });
  run(new LanguageDetectionMetadataFilter({ identifier: source }), none, empty);
  assert.deepEqual(source.calls, []);
  assert.deepEqual(none.names(), ["dc:title"]);
  assert.deepEqual(empty.names().sort(), [TIKA_KEYS.CONTENT, "dc:title"].sort());
});

test("blank content is detected: only content that is absent or empty is skipped", () => {
  const source = identifier(NOTHING);
  const metadata = document({ [TIKA_KEYS.CONTENT]: "  \n " });
  run(new LanguageDetectionMetadataFilter({ identifier: source }), metadata);
  assert.equal(source.calls.length, 1);
  assert.equal(metadata.get(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE), "NONE");
});

test("what a document had under the keys is replaced, not added to", () => {
  const metadata = new Metadata();
  metadata.add(TIKA_KEYS.CONTENT, "Hello");
  for (const key of [TIKA_KEYS.DETECTED_LANGUAGE, TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE, TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE_RAW]) {
    metadata.add(key, "old");
    metadata.add(key, "older");
  }
  run(new LanguageDetectionMetadataFilter({ identifier: identifier(ENGLISH) }), metadata);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.DETECTED_LANGUAGE), ["eng"]);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE), ["HIGH"]);
  assert.deepEqual(metadata.getAll(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE_RAW), ["0.8999999761581421"]);
});

test("every document of the list is detected on its own content, and nothing else of it changes", () => {
  const source = identifier(ENGLISH, { language: "fra", confidence: "MEDIUM", rawScore: 0.75 });
  const container = document({ [TIKA_KEYS.CONTENT]: "one", "dc:title": "t" });
  const embedded = document({ [TIKA_KEYS.CONTENT]: "deux", [TIKA_KEYS.EMBEDDED_DEPTH]: "1" });
  run(new LanguageDetectionMetadataFilter({ identifier: source }), container, embedded);
  assert.deepEqual(source.calls.map((call) => call.text), ["one", "deux"]);
  assert.equal(container.get(TIKA_KEYS.DETECTED_LANGUAGE), "eng");
  assert.equal(embedded.get(TIKA_KEYS.DETECTED_LANGUAGE), "fra");
  assert.equal(embedded.get(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE), "MEDIUM");
  assert.equal(embedded.get(TIKA_KEYS.DETECTED_LANGUAGE_CONFIDENCE_RAW), "0.75");
  assert.equal(container.get("dc:title"), "t");
  assert.equal(embedded.get(TIKA_KEYS.EMBEDDED_DEPTH), "1");
});

test("maxLength is given to the identifier with every text", () => {
  const source = identifier(ENGLISH);
  run(new LanguageDetectionMetadataFilter({ identifier: source, maxLength: 10_000 }), document({ [TIKA_KEYS.CONTENT]: "a" }), document({ [TIKA_KEYS.CONTENT]: "b" }));
  assert.deepEqual(source.calls.map((call) => call.maxLength), [10_000, 10_000]);
});

test("without a maxLength the identifier's own default stands", () => {
  const source = identifier(ENGLISH);
  run(new LanguageDetectionMetadataFilter({ identifier: source }), document({ [TIKA_KEYS.CONTENT]: "a" }));
  assert.deepEqual(source.calls.map((call) => call.maxLength), [undefined]);
});

test("a maxLength that reads no characters is refused when the filter is made, not on every document", () => {
  for (const maxLength of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    assert.throws(
      () => new LanguageDetectionMetadataFilter({ identifier: identifier(ENGLISH), maxLength }),
      /maxLength must be a whole number from 1 to 2147483647/,
      String(maxLength),
    );
  }
  assert.doesNotThrow(() => new LanguageDetectionMetadataFilter({ identifier: identifier(ENGLISH), maxLength: 1 }));
  assert.doesNotThrow(() => new LanguageDetectionMetadataFilter({ identifier: identifier(ENGLISH), maxLength: 2 ** 31 - 1 }));
});

test("a failing identifier is not swallowed", () => {
  const failing: LanguageIdentifier = {
    identify() {
      throw new Error("model is gone");
    },
  };
  assert.throws(() => run(new LanguageDetectionMetadataFilter({ identifier: failing }), document({ [TIKA_KEYS.CONTENT]: "x" })), /model is gone/);
});
