import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaType,
  ParseContext,
  RipstreamConfigError,
  UnsupportedFormatError,
  loadConfig,
  type CompositeParser,
  type Parser,
} from "@spikedpunch/ripstream-core";
import { MimeTypes } from "@spikedpunch/ripstream-mime";
import { createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * A `parsers` section is Tika's: `default-parser` is every parser Tika loads by default, its `exclude` names the ones
 * to leave out, a named entry brings in exactly that parser (and, with the marker present, takes it out of the default
 * set), and `_mime-include` / `_mime-exclude` narrow what a parser or the default set may take
 * (AbstractSpiComponentLoader and ParserLoader, tika-serialization 4.2.0). Ripstream's parsers do not line up with
 * Tika's one to one (ImageParser serves what Tika splits across eight parser classes), so the section is applied to
 * MEDIA TYPES: each ripstream parser keeps the types some enabled Tika parser claims.
 */

const context = new ParseContext();
const type = (value: string): MediaType => MediaType.parseOrThrow(value);
const parserList = (parsers: unknown): CompositeParser => createDefaultParser({ config: loadConfig({ parsers }) });
const taking = async (composite: CompositeParser, value: string): Promise<string[]> =>
  (await composite.selectParsers(type(value), context)).map((match) => match.parser.name);

/** Parsers that claim the type itself, not only a supertype of it (application/json is a kind of text/plain). */
const claiming = async (composite: CompositeParser, value: string): Promise<string[]> =>
  (await composite.selectParsers(type(value), context)).filter((match) => match.kind === "exact").map((match) => match.parser.name);

const DEFAULT = createDefaultParser();

test("no parsers section, an empty one, and a bare default-parser change nothing", async () => {
  const same = (composite: CompositeParser): void => {
    assert.deepEqual(
      composite.getParsers().map((parser) => parser.name),
      DEFAULT.getParsers().map((parser) => parser.name),
    );
  };
  same(createDefaultParser({ config: loadConfig({}) }));
  same(parserList([]));
  same(parserList(["default-parser"]));
  same(parserList([{ "default-parser": {} }]));
  // Unwrapped: the very same parser objects Ripstream would have run.
  const bare = parserList([{ "default-parser": {} }]).getParsers();
  assert.ok(bare.every((parser) => !("delegate" in parser)));
});

test("default-parser with exclude takes the named parser's types out", async () => {
  assert.deepEqual(await taking(DEFAULT, "application/pdf"), ["PDFParser"]);
  const without = parserList([{ "default-parser": { exclude: ["pdf-parser"] } }]);
  assert.deepEqual(await taking(without, "application/pdf"), []);
});

test("excluding one Tika parser leaves the others that the same ripstream parser serves", async () => {
  // ImageParser serves jpeg and gif; Tika's jpeg-parser claims only image/jpeg.
  assert.ok((await taking(DEFAULT, "image/jpeg")).includes("ImageParser"));
  const without = parserList([{ "default-parser": { exclude: ["jpeg-parser"] } }]);
  assert.deepEqual(await taking(without, "image/jpeg"), []);
  assert.ok((await taking(without, "image/gif")).includes("ImageParser"));
});

test("a type another enabled Tika parser also claims stays served", async () => {
  // audio/ogg is claimed by ogg-parser, opus-parser and speex-parser.
  assert.ok((await taking(DEFAULT, "audio/ogg")).length > 0);
  const oneLeft = parserList([{ "default-parser": { exclude: ["ogg-parser", "opus-parser"] } }]);
  assert.ok((await taking(oneLeft, "audio/ogg")).length > 0);
  const noneLeft = parserList([{ "default-parser": { exclude: ["ogg-parser", "opus-parser", "speex-parser"] } }]);
  assert.deepEqual(await taking(noneLeft, "audio/ogg"), []);
});

test("without the marker only the named parsers are loaded", async () => {
  const only = parserList(["pdf-parser"]);
  assert.deepEqual(await taking(only, "application/pdf"), ["PDFParser"]);
  assert.deepEqual(await taking(only, "text/plain"), []);
  assert.deepEqual(await taking(only, "image/jpeg"), []);
  assert.deepEqual(
    only.getParsers().map((parser) => parser.name),
    ["PDFParser"],
  );
});

test("a named entry beside the marker leaves the default set, so its filters replace the default", async () => {
  // Tika excludes every listed class from the default parser: pdf-parser here is the listed one, with its own filter.
  const config = [{ "default-parser": {} }, { "pdf-parser": { "_mime-exclude": ["application/pdf"] } }];
  assert.deepEqual(await taking(parserList(config), "application/pdf"), []);
  assert.ok((await taking(parserList(config), "text/plain")).length > 0);
});

test("_mime-include on a named parser keeps only those of its types", async () => {
  // ooxml-parser claims many OOXML types; keep one.
  const only = parserList([
    { "ooxml-parser": { "_mime-include": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] } },
  ]);
  assert.ok(
    (await taking(only, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).includes("OOXMLParser"),
  );
  assert.deepEqual(await taking(only, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), []);
});

test("_mime-exclude on the marker narrows the whole default set", async () => {
  const narrowed = parserList([{ "default-parser": { "_mime-exclude": ["application/pdf"] } }]);
  assert.deepEqual(await taking(narrowed, "application/pdf"), []);
  assert.ok((await taking(narrowed, "text/plain")).length > 0);
});

test("_mime-include on the marker leaves only those types, ripstream-only ones included in the cut", async () => {
  const only = parserList([{ "default-parser": { "_mime-include": ["application/pdf"] } }]);
  assert.deepEqual(await taking(only, "application/pdf"), ["PDFParser"]);
  assert.deepEqual(await taking(only, "text/plain"), []);
});

test("a type no Tika parser claims is ripstream's own coverage: it follows the marker", async () => {
  // application/json is served by TextParser but is in no standard-server parser's list.
  assert.deepEqual(await claiming(DEFAULT, "application/json"), ["TextParser"]);
  const withMarker = parserList([{ "default-parser": { exclude: ["text-and-csv-parser"] } }]);
  assert.deepEqual(await taking(withMarker, "text/plain"), []);
  assert.deepEqual(await claiming(withMarker, "application/json"), ["TextParser"]);
  // Without the marker nothing but the named parsers is loaded, ripstream's own types included. (JSON still reaches
  // TextParser through its supertype text/plain, as it reaches Tika's text-and-csv-parser.)
  const named = parserList(["text-and-csv-parser"]);
  assert.deepEqual(await claiming(named, "application/json"), []);
  assert.deepEqual(await taking(named, "application/json"), ["TextParser"]);
  // A marker filter reaches it too.
  assert.deepEqual(await claiming(parserList([{ "default-parser": { "_mime-exclude": ["application/json"] } }]), "application/json"), []);
});

test("a catch-all goes once a type in its range is excluded, so it cannot turn that type back on", async () => {
  // TextParser claims text/* as well as text/plain. Tika's fallback for an unknown text type runs through its text parser.
  assert.deepEqual(await taking(DEFAULT, "text/x-never-heard-of"), ["TextParser"]);
  const without = parserList([{ "default-parser": { exclude: ["text-and-csv-parser"] } }]);
  assert.deepEqual(await taking(without, "text/x-never-heard-of"), []);
  assert.deepEqual(await taking(without, "text/plain"), []);
  // Excluding something outside text/ leaves the catch-all alone.
  const other = parserList([{ "default-parser": { exclude: ["pdf-parser"] } }]);
  assert.deepEqual(await taking(other, "text/x-never-heard-of"), ["TextParser"]);
});

test("an alias a ripstream parser claims is the same type as the one Tika names", () => {
  // GzipParser claims application/x-gzip, an alias of application/gzip, which Tika's compressor-parser claims.
  const registry = new MimeTypes().getMediaTypeRegistry();
  const canonical = (value: MediaType): string => (registry.normalize(value) ?? value).getBaseType().toString();
  const claims = (composite: CompositeParser): string[] =>
    composite.getParsers().flatMap((parser) => [...(parser.getSupportedTypes(context) as ReadonlySet<MediaType>)].map(canonical));
  assert.ok(claims(DEFAULT).includes("application/gzip"));
  assert.ok(DEFAULT.getParsers().some((parser) => [...(parser.getSupportedTypes(context) as ReadonlySet<MediaType>)].some((t) => t.toString() === "application/x-gzip")));
  const without = parserList([{ "default-parser": { exclude: ["compressor-parser"] } }]);
  assert.ok(!claims(without).includes("application/gzip"), "the alias kept the type alive");
});

test("a filtered parser keeps its name and capabilities, so hazard accounting still sees it", () => {
  const filtered = parserList([{ "default-parser": { exclude: ["jpeg-parser"] } }]).getParsers();
  for (const original of DEFAULT.getParsers()) {
    const kept = filtered.find((parser) => parser.name === original.name);
    if (kept === undefined) continue;
    assert.deepEqual(kept.capabilities, original.capabilities, original.name);
  }
  const image = filtered.find((parser) => parser.name === "ImageParser") as Parser;
  assert.equal(image.capabilities?.unsafe, true);
});

test("a parser left with no type is dropped", () => {
  const names = parserList(["pdf-parser"]).getParsers().map((parser) => parser.name);
  assert.deepEqual(names, ["PDFParser"]);
});

test("naming a parser ripstream does not implement is an error, not an empty parser", () => {
  assert.throws(
    () => parserList(["bpg-parser"]),
    (error: unknown) => error instanceof RipstreamConfigError && /parser "bpg-parser" is not implemented/.test(error.message),
  );
});

test("naming a parser outside the standard server's inventory is an error that says why", () => {
  // grib-parser is a real Tika parser (an extended module), but nothing records the types it claims.
  assert.throws(
    () => parserList(["grib-parser"]),
    (error: unknown) => error instanceof RipstreamConfigError && /parser "grib-parser" cannot be applied.*media types/.test(error.message),
  );
  // txt-parser is in the standard server but only as a helper: it claims no types of its own.
  assert.throws(() => parserList(["txt-parser"]), /parser "txt-parser" cannot be applied/);
});

test("excluding a parser ripstream does not implement is fine: it is already not loaded", async () => {
  const without = parserList([{ "default-parser": { exclude: ["bpg-parser", "grib-parser"] } }]);
  assert.ok((await taking(without, "application/pdf")).length > 0);
});

test("every problem is reported at once", () => {
  assert.throws(
    () => parserList(["bpg-parser", "grib-parser"]),
    (error: unknown) => error instanceof RipstreamConfigError && error.issues.length === 2,
  );
});

test("a parsers section cannot be combined with an explicit parser list", () => {
  assert.throws(
    () => createDefaultParser({ parsers: [], config: loadConfig({ parsers: ["pdf-parser"] }) }),
    (error: unknown) => error instanceof RipstreamConfigError && /cannot be combined with `parsers`/.test(error.message),
  );
  // A config with no parsers section still works beside an explicit list.
  createDefaultParser({ parsers: [], config: loadConfig({}) });
});

test("createRipstream applies the section end to end", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
  const refused = createRipstream({ config: loadConfig({ parsers: [{ "default-parser": { exclude: ["pdf-parser"] } }] }) });
  await assert.rejects(refused.parse(pdf), UnsupportedFormatError);
  // The default still takes it as a PDF (and finds it malformed, which is a different failure).
  await assert.rejects(createRipstream().parse(pdf), (error: unknown) => !(error instanceof UnsupportedFormatError));
  // Other formats are untouched.
  const result = await refused.parse(new TextEncoder().encode("Hello config"), { filename: "a.txt" });
  assert.match(result.text, /Hello config/);
});

/** Two lines drawn bottom first, so the text reads in a different order with and without `sortByPosition`. */
function twoLinePdf(): Uint8Array {
  const content = "BT /F1 12 Tf 72 600 Td (Bottom line) Tj ET\nBT /F1 12 Tf 72 700 Td (Top line) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const body = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`);
  return Buffer.from(`%PDF-1.4\n${body.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

test("a pdf-parser entry sets the PDFParserConfig properties of the parser that reads PDFs", async () => {
  const order = async (config: object): Promise<string[]> => {
    const { text } = await createRipstream({ config: loadConfig(config) }).parse(twoLinePdf(), { filename: "a.pdf" });
    return ["Top line", "Bottom line"].sort((a, b) => text.indexOf(a) - text.indexOf(b));
  };
  const sorted = ["Top line", "Bottom line"];
  assert.deepEqual(await order({}), sorted);
  assert.deepEqual(await order({ parsers: ["default-parser"] }), sorted);
  assert.deepEqual(await order({ parsers: [{ "pdf-parser": { sortByPosition: true } }] }), sorted);
  assert.deepEqual(await order({ parsers: [{ "pdf-parser": { sortByPosition: false } }] }), [...sorted].reverse());
});
