import assert from "node:assert/strict";
import { test } from "node:test";
import { RipstreamConfigError, loadConfig, validateConfig } from "../src/index.ts";
import { parseComponentSection } from "../src/component-config.ts";

/*
 * Tika's `parsers` section: an array whose entries are a component name ("pdf-parser") or an object with one key, the
 * name, whose value carries that component's settings. `default-parser` stands for every parser Tika loads by default
 * (AbstractSpiComponentLoader, tika-serialization 4.2.0). What is read here is only the shape and the names; applying
 * them to a parser list is the parsers package's job.
 */

const parsers = (value: unknown) => parseComponentSection("parsers", value);

test("a name, an object entry and the default marker all normalize to one shape", () => {
  const { entries, issues } = parsers([
    "pdf-parser",
    { "rtf-parser": {} },
    { "default-parser": { exclude: ["executable-parser"], "_mime-exclude": ["image/jpeg"] } },
  ]);
  assert.deepEqual(issues, []);
  assert.deepEqual(entries, [
    { name: "pdf-parser", marker: false, exclude: [], mimeInclude: [], mimeExclude: [] },
    { name: "rtf-parser", marker: false, exclude: [], mimeInclude: [], mimeExclude: [] },
    { name: "default-parser", marker: true, exclude: ["executable-parser"], mimeInclude: [], mimeExclude: ["image/jpeg"] },
  ]);
});

test("an empty array is valid: Tika treats it as no section, the full default", () => {
  assert.deepEqual(parsers([]), { entries: [], issues: [] });
});

test("the section must be an array", () => {
  for (const value of [{}, "pdf-parser", 5, null, true]) {
    assert.match(parsers(value).issues.join("|"), /parsers must be an array/, String(value));
  }
});

test("an entry must be a name or an object", () => {
  for (const entry of [5, null, true, [], ["pdf-parser"]]) {
    assert.match(parsers([entry]).issues.join("|"), /parsers\[0\] must be a component name or an object/, JSON.stringify(entry));
  }
  assert.match(parsers([""]).issues.join("|"), /parsers\[0\]/);
});

test("an unknown name is refused, with its position", () => {
  assert.deepEqual(parsers(["pdf-parser", "no-such-parser"]).issues, [`parsers[1]: unknown parser "no-such-parser"`]);
  assert.deepEqual(parsers([{ "no-such-parser": {} }]).issues, [`parsers[0]: unknown parser "no-such-parser"`]);
});

test("a name of another kind of component is not a parser", () => {
  // mime-types is a detector; pdf-parser is not a detector.
  assert.match(parsers(["mime-types"]).issues.join("|"), /unknown parser "mime-types"/);
});

test("a Java class name is not a component name", () => {
  assert.match(parsers(["org.apache.tika.parser.pdf.PDFParser"]).issues.join("|"), /unknown parser/);
});

test("an object entry with more than one key is refused: Tika would read the first and drop the rest", () => {
  const issue = parsers([{ "pdf-parser": {}, "rtf-parser": {} }]).issues.join("|");
  assert.match(issue, /parsers\[0\] has 2 keys; an entry has exactly one/);
  assert.match(parsers([{}]).issues.join("|"), /parsers\[0\] has 0 keys; an entry has exactly one/);
});

test("a component's settings must be an object", () => {
  for (const body of [5, "x", [], true]) {
    assert.match(parsers([{ "pdf-parser": body }]).issues.join("|"), /parsers\[0\] "pdf-parser": settings must be an object/, JSON.stringify(body));
  }
});

test("a setting ripstream cannot apply is refused by name, never dropped", () => {
  assert.deepEqual(parsers([{ "pdf-parser": { sortByPosition: true } }]).issues, [
    `parsers[0] "pdf-parser": setting "sortByPosition" is not supported`,
  ]);
  // exclude belongs to the default marker only.
  assert.match(parsers([{ "pdf-parser": { exclude: ["rtf-parser"] } }]).issues.join("|"), /"pdf-parser": setting "exclude" is not supported/);
  // The marker takes no settings but its own.
  assert.match(parsers([{ "default-parser": { sortByPosition: true } }]).issues.join("|"), /"default-parser": setting "sortByPosition"/);
});

test("exclude lists registered parser names", () => {
  assert.deepEqual(parsers([{ "default-parser": { exclude: ["no-such-parser"] } }]).issues, [
    `parsers[0] "default-parser": exclude names unknown parser "no-such-parser"`,
  ]);
  assert.match(parsers([{ "default-parser": { exclude: "pdf-parser" } }]).issues.join("|"), /exclude must be an array of parser names/);
  // Tika skips a non-string item and carries on, so the component stays enabled; here it is an error.
  assert.match(parsers([{ "default-parser": { exclude: ["pdf-parser", 5] } }]).issues.join("|"), /exclude\[1\] must be a parser name/);
});

test("_mime-include and _mime-exclude take media types", () => {
  const { entries, issues } = parsers([
    { "pdf-parser": { "_mime-include": ["application/pdf"], "_mime-exclude": "text/plain" } },
  ]);
  assert.deepEqual(issues, []);
  assert.deepEqual(entries[0], {
    name: "pdf-parser",
    marker: false,
    exclude: [],
    mimeInclude: ["application/pdf"],
    mimeExclude: ["text/plain"],
  });
  assert.match(parsers([{ "pdf-parser": { "_mime-include": ["not a type"] } }]).issues.join("|"), /_mime-include\[0\] "not a type" is not a media type/);
  assert.match(parsers([{ "pdf-parser": { "_mime-include": [5] } }]).issues.join("|"), /_mime-include\[0\] must be a media type/);
  assert.match(parsers([{ "pdf-parser": { "_mime-exclude": {} } }]).issues.join("|"), /_mime-exclude must be a media type or an array of them/);
});

test("the retired image/ocr-* pseudo-types are refused, as Tika 4.2 refuses them", () => {
  assert.match(parsers([{ "pdf-parser": { "_mime-exclude": ["image/ocr-png"] } }]).issues.join("|"), /image\/ocr-png.*retired/);
});

test("the default marker may appear once", () => {
  assert.match(parsers(["default-parser", { "default-parser": {} }]).issues.join("|"), /"default-parser" appears more than once/);
});

test("every problem is reported at once", () => {
  const { issues } = parsers(["nope", { "pdf-parser": { bogus: 1 } }, 5]);
  assert.equal(issues.length, 3, issues.join("|"));
});

test("detectors use their own names and marker", () => {
  const { entries, issues } = parseComponentSection("detectors", [{ "default-detector": { exclude: ["ogg-detector"] } }, "mime-types"]);
  assert.deepEqual(issues, []);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.marker]), [["default-detector", true], ["mime-types", false]]);
  assert.match(parseComponentSection("detectors", ["pdf-parser"]).issues.join("|"), /unknown detector "pdf-parser"/);
});

test("loadConfig keeps the normalized parsers section", () => {
  const config = loadConfig({ parsers: [{ "default-parser": { exclude: ["executable-parser"] } }] });
  assert.equal(config.parsers?.length, 1);
  assert.deepEqual(config.parsers?.[0]?.exclude, ["executable-parser"]);
  assert.equal(loadConfig({}).parsers, null);
});

test("loadConfig and validateConfig refuse a bad parsers section, naming it", () => {
  assert.throws(
    () => loadConfig({ parsers: ["no-such-parser"] }),
    (error: unknown) => error instanceof RipstreamConfigError && /parsers\[0\]: unknown parser "no-such-parser"/.test(error.message),
  );
  assert.match(validateConfig({ parsers: [{ "pdf-parser": { sortByPosition: true } }] }).join("|"), /setting "sortByPosition"/);
  assert.deepEqual(validateConfig({ parsers: [{ "default-parser": {} }] }), []);
});

test("loadConfig reads the section from JSON text, and keeps refusing the sections still unapplied", () => {
  assert.equal(loadConfig('{"parsers":["pdf-parser"]}').parsers?.[0]?.name, "pdf-parser");
  assert.throws(() => loadConfig('{"contentHandlers":[]}'), /"contentHandlers" is not supported/);
  assert.throws(() => loadConfig('{"detectors":["mime-types"]}'), /"detectors" is not supported/);
});
