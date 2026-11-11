import assert from "node:assert/strict";
import { test } from "node:test";
import { UPSTREAM_COMPONENTS } from "../src/generated/upstream-services.ts";
import { parseMetadataFilterSection } from "../src/metadata-filter-config.ts";
import {
  Metadata,
  NoOpFilter,
  ParseContext,
  RipstreamConfig,
  RipstreamConfigError,
  createMetadataFilter,
  loadConfig,
  validateConfig,
  type MetadataFilterEntry,
} from "../src/index.ts";

type Fields = Readonly<Record<string, string>>;

function metadataOf(fields: Fields): Metadata {
  const metadata = new Metadata();
  for (const [name, value] of Object.entries(fields)) metadata.add(name, value);
  return metadata;
}

function fieldsOf(metadata: Metadata): Fields {
  return Object.fromEntries(metadata.names().map((name) => [name, metadata.get(name)!]));
}

function entriesOf(section: unknown): readonly MetadataFilterEntry[] {
  const entries = loadConfig({ "metadata-filters": section }).metadataFilters;
  assert.notEqual(entries, null);
  return entries!;
}

/** Runs the chain `section` names over one document per set of fields; returns what each document is left with. */
function run(section: unknown, ...documents: Fields[]): Fields[] {
  const list = documents.map(metadataOf);
  createMetadataFilter(entriesOf(section)).filter(list, new ParseContext());
  return list.map(fieldsOf);
}

function issuesOf(section: unknown): string[] {
  return validateConfig({ "metadata-filters": section });
}

const FILTER_NAMES = [
  "capture-group-metadata-filter",
  "clear-by-attachment-type-metadata-filter",
  "date-normalizing-metadata-filter",
  "exclude-field-metadata-filter",
  "field-name-mapping-filter",
  "geo-point-metadata-filter",
  "include-field-metadata-filter",
  "legacy-key-migration-filter",
  "no-op-filter",
  "remove-by-mime-metadata-filter",
];

test("a configuration with no metadata-filters section has no chain", () => {
  const config = loadConfig({});
  assert.equal(config.metadataFilters, null);
  assert.equal(config.parseContextMetadataFilters, null);
});

test("an empty list is no filter at all: the document comes out as it went in", () => {
  assert.deepEqual(entriesOf([]), []);
  assert.ok(createMetadataFilter([]) instanceof NoOpFilter);
  assert.deepEqual(run([], { a: "1", "tk:content": "text" }), [{ a: "1", "tk:content": "text" }]);
});

test("an entry is a filter's name or an object keyed by it, and the order is kept", () => {
  assert.deepEqual(entriesOf(["no-op-filter", { "include-field-metadata-filter": { include: ["a"] } }, { "no-op-filter": {} }]), [
    { name: "no-op-filter", settings: {} },
    { name: "include-field-metadata-filter", settings: { include: ["a"] } },
    { name: "no-op-filter", settings: {} },
  ]);
});

test("the entries are frozen copies, so changing what was passed changes nothing", () => {
  const source = { "include-field-metadata-filter": { include: ["a"] } };
  const config = loadConfig({ "metadata-filters": [source] });
  source["include-field-metadata-filter"].include.push("b");
  const entry = config.metadataFilters![0]!;
  assert.deepEqual(entry.settings, { include: ["a"] });
  assert.ok(Object.isFrozen(config.metadataFilters));
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.settings));
  assert.ok(Object.isFrozen(entry.settings.include));
});

test("every filter Tika ships in tika-core has a name that is accepted, with default settings", () => {
  for (const name of FILTER_NAMES) {
    if (name === "capture-group-metadata-filter") continue; // its three settings are required
    assert.deepEqual(issuesOf([name]), [], name);
    assert.deepEqual(issuesOf([{ [name]: {} }]), [], name);
  }
});

// [what it shows, the entry, the document, what is left of it]
const BEHAVIOUR: ReadonlyArray<readonly [string, unknown, Fields, Fields]> = [
  ["include keeps the named fields", { "include-field-metadata-filter": { include: ["a", "c"] } }, { a: "1", b: "2", c: "3" }, { a: "1", c: "3" }],
  ["include with no list keeps nothing, as Tika's empty default does", "include-field-metadata-filter", { a: "1" }, {}],
  ["exclude drops the named fields", { "exclude-field-metadata-filter": { exclude: ["b"] } }, { a: "1", b: "2" }, { a: "1" }],
  ["exclude with no list drops nothing", "exclude-field-metadata-filter", { a: "1" }, { a: "1" }],
  ["mapping renames, and drops what it does not map", { "field-name-mapping-filter": { mappings: { a: "x" } } }, { a: "1", b: "2" }, { x: "1" }],
  [
    "mapping keeps the rest with excludeUnmapped false",
    { "field-name-mapping-filter": { mappings: { a: "x" }, excludeUnmapped: false } },
    { a: "1", b: "2" },
    { x: "1", b: "2" },
  ],
  ["mapping with no mappings drops everything: excludeUnmapped is true by default", "field-name-mapping-filter", { a: "1" }, {}],
  [
    "clear-by-attachment-type empties a document of a type it names",
    { "clear-by-attachment-type-metadata-filter": { types: ["INLINE"] } },
    { "tk:embedded-resource-type": "INLINE", a: "1" },
    {},
  ],
  [
    "clear-by-attachment-type leaves a document of another type",
    { "clear-by-attachment-type-metadata-filter": { types: ["INLINE"] } },
    { "tk:embedded-resource-type": "ATTACHMENT", a: "1" },
    { "tk:embedded-resource-type": "ATTACHMENT", a: "1" },
  ],
  [
    "date-normalizing reads a date with no zone in defaultTimeZone",
    { "date-normalizing-metadata-filter": { defaultTimeZone: "America/New_York" } },
    { "dcterms:created": "2015-06-12" },
    { "dcterms:created": "2015-06-12T16:00:00Z" },
  ],
  ["date-normalizing reads it in UTC by default", "date-normalizing-metadata-filter", { "dcterms:created": "2015-06-12" }, { "dcterms:created": "2015-06-12T12:00:00Z" }],
  [
    "capture-group writes group 1 of the regex over the source to the target",
    { "capture-group-metadata-filter": { regex: "\\A([^;]+)", sourceField: "Content-Type", targetField: "mime" } },
    { "Content-Type": "text/plain; charset=UTF-8" },
    { "Content-Type": "text/plain; charset=UTF-8", mime: "text/plain" },
  ],
  ["geo-point writes latitude,longitude to location", "geo-point-metadata-filter", { "geo:lat": "1", "geo:long": "2" }, { "geo:lat": "1", "geo:long": "2", location: "1,2" }],
  [
    "geo-point writes it to the field it is told",
    { "geo-point-metadata-filter": { geoPointFieldName: "where" } },
    { "geo:lat": "1", "geo:long": "2" },
    { "geo:lat": "1", "geo:long": "2", where: "1,2" },
  ],
  ["legacy-key-migration goes from 4.x to 3.x by default", "legacy-key-migration-filter", { "tk:content": "x" }, { "X-TIKA:content": "x" }],
  [
    "legacy-key-migration goes from 3.x to 4.x when it is told",
    { "legacy-key-migration-filter": { direction: "V3_TO_V4" } },
    { "X-TIKA:content": "x" },
    { "tk:content": "x" },
  ],
  [
    "legacy-key-migration accepts Tika's own default table",
    { "legacy-key-migration-filter": { table: "/org/apache/tika/metadata/metadata-migration-3x-4x.json" } },
    { "tk:content": "x" },
    { "X-TIKA:content": "x" },
  ],
  ["no-op does nothing", "no-op-filter", { a: "1" }, { a: "1" }],
];

for (const [what, entry, before, after] of BEHAVIOUR) {
  test(`the chain applies it: ${what}`, () => {
    assert.deepEqual(run([entry], before), [after]);
  });
}

test("remove-by-mime takes a document out of the list, and leaves one with no type or another", () => {
  const result = run(
    [{ "remove-by-mime-metadata-filter": { mimes: ["image/png"] } }],
    { "Content-Type": "image/png; x=y", n: "1" },
    { "Content-Type": "text/plain", n: "2" },
    { n: "3" },
  );
  assert.deepEqual(result, [{ "Content-Type": "text/plain", n: "2" }, { n: "3" }]);
});

test("remove-by-mime with no list removes nothing", () => {
  assert.deepEqual(run(["remove-by-mime-metadata-filter"], { "Content-Type": "image/png" }), [{ "Content-Type": "image/png" }]);
});

test("the filters run in the order listed, each on what the one before left", () => {
  const mapThenInclude = [
    { "field-name-mapping-filter": { mappings: { a: "x", b: "y" } } },
    { "include-field-metadata-filter": { include: ["x"] } },
  ];
  assert.deepEqual(run(mapThenInclude, { a: "1", b: "2" }), [{ x: "1" }]);
  const includeThenMap = [mapThenInclude[1], mapThenInclude[0]];
  assert.deepEqual(run(includeThenMap, { a: "1", b: "2" }), [{}]);
});

test("a filter may be listed twice", () => {
  const twice = [{ "exclude-field-metadata-filter": { exclude: ["a"] } }, { "exclude-field-metadata-filter": { exclude: ["b"] } }];
  assert.deepEqual(run(twice, { a: "1", b: "2", c: "3" }), [{ c: "3" }]);
});

test("a configuration is the same read as JSON text", () => {
  const config = loadConfig(JSON.stringify({ "metadata-filters": [{ "include-field-metadata-filter": { include: ["a"] } }] }));
  assert.deepEqual(config.metadataFilters, [{ name: "include-field-metadata-filter", settings: { include: ["a"] } }]);
});

// What Tika would accept and ripstream cannot honor, or that is simply wrong: each is reported with where it is.

const REFUSALS: ReadonlyArray<readonly [string, unknown, string]> = [
  ["a section that is not a list", { "no-op-filter": {} }, "metadata-filters must be an array"],
  ["a number", [5], "metadata-filters[0] must be a component name or an object"],
  ["an empty name", [""], "metadata-filters[0] must be a component name or an object"],
  ["null", [null], "metadata-filters[0] must be a component name or an object"],
  ["an entry with two keys", [{ "no-op-filter": {}, "include-field-metadata-filter": {} }], "metadata-filters[0] has 2 keys; an entry has exactly one"],
  ["an entry with none", [{}], "metadata-filters[0] has 0 keys; an entry has exactly one"],
  ["settings that are not an object", [{ "no-op-filter": "yes" }], 'metadata-filters[0] "no-op-filter": settings must be an object'],
  ["settings that are a list", [{ "include-field-metadata-filter": ["a"] }], 'metadata-filters[0] "include-field-metadata-filter": settings must be an object'],
  [
    "a name that is not a filter",
    ["pdf-parser"],
    'metadata-filters[0]: "pdf-parser" is not a metadata filter: it is listed under parsers',
  ],
  ["a setting of the no-op filter", [{ "no-op-filter": { a: 1 } }], 'metadata-filters[0] "no-op-filter": setting "a" is not supported (no-op-filter takes no settings)'],
  [
    "a setting a filter does not have",
    [{ "include-field-metadata-filter": { exclude: ["a"] } }],
    'metadata-filters[0] "include-field-metadata-filter": setting "exclude" is not supported (include-field-metadata-filter reads: include)',
  ],
  [
    "a setting spelt in the wrong case",
    [{ "field-name-mapping-filter": { excludeunmapped: false } }],
    'metadata-filters[0] "field-name-mapping-filter": setting "excludeunmapped" is not supported (field-name-mapping-filter reads: mappings, excludeUnmapped)',
  ],
  ["include that is not a list", [{ "include-field-metadata-filter": { include: "a" } }], 'metadata-filters[0] "include-field-metadata-filter": setting "include" must be an array of strings'],
  ["include with null", [{ "include-field-metadata-filter": { include: null } }], 'metadata-filters[0] "include-field-metadata-filter": setting "include" must be an array of strings'],
  [
    "include with a number in it",
    [{ "include-field-metadata-filter": { include: ["a", 2] } }],
    'metadata-filters[0] "include-field-metadata-filter": setting "include"[1] must be a string',
  ],
  ["exclude that is not a list", [{ "exclude-field-metadata-filter": { exclude: {} } }], 'metadata-filters[0] "exclude-field-metadata-filter": setting "exclude" must be an array of strings'],
  [
    "mappings that are not an object",
    [{ "field-name-mapping-filter": { mappings: ["a"] } }],
    'metadata-filters[0] "field-name-mapping-filter": setting "mappings" must be an object of field names to field names',
  ],
  [
    "a mapping to something that is not a name",
    [{ "field-name-mapping-filter": { mappings: { a: 1 } } }],
    'metadata-filters[0] "field-name-mapping-filter": setting "mappings" "a" must be a field name (a string)',
  ],
  [
    "excludeUnmapped that is not a boolean",
    [{ "field-name-mapping-filter": { excludeUnmapped: "false" } }],
    'metadata-filters[0] "field-name-mapping-filter": setting "excludeUnmapped" must be true or false',
  ],
  ["mimes that are not a list", [{ "remove-by-mime-metadata-filter": { mimes: "image/png" } }], 'metadata-filters[0] "remove-by-mime-metadata-filter": setting "mimes" must be an array of strings'],
  [
    "a mime that is not a media type",
    [{ "remove-by-mime-metadata-filter": { mimes: ["image"] } }],
    'metadata-filters[0] "remove-by-mime-metadata-filter": setting "mimes"[0] "image" is not a media type',
  ],
  [
    "a mime in upper case, which could never match",
    [{ "remove-by-mime-metadata-filter": { mimes: ["Image/PNG"] } }],
    'metadata-filters[0] "remove-by-mime-metadata-filter": setting "mimes"[0] "Image/PNG" can never match: the filter compares the base type, in lower case and with no parameters ("image/png")',
  ],
  [
    "a mime with a parameter, which could never match",
    [{ "remove-by-mime-metadata-filter": { mimes: ["text/plain; charset=UTF-8"] } }],
    'metadata-filters[0] "remove-by-mime-metadata-filter": setting "mimes"[0] "text/plain; charset=UTF-8" can never match: the filter compares the base type, in lower case and with no parameters ("text/plain")',
  ],
  [
    "a type that is not an attachment type",
    [{ "clear-by-attachment-type-metadata-filter": { types: ["inline"] } }],
    'metadata-filters[0] "clear-by-attachment-type-metadata-filter": "inline" is not an attachment type. The types are (case-sensitive): INLINE, ATTACHMENT, MACRO, METADATA, FONT, THUMBNAIL, RENDERING, VERSION, ALTERNATE_FORMAT_CHUNK',
  ],
  ["types that are not a list", [{ "clear-by-attachment-type-metadata-filter": { types: "INLINE" } }], 'metadata-filters[0] "clear-by-attachment-type-metadata-filter": setting "types" must be an array of strings'],
  [
    "a zone that does not exist",
    [{ "date-normalizing-metadata-filter": { defaultTimeZone: "Mars/Olympus_Mons" } }],
    'metadata-filters[0] "date-normalizing-metadata-filter": Unknown time-zone ID: Mars/Olympus_Mons',
  ],
  ["a zone that is not a string", [{ "date-normalizing-metadata-filter": { defaultTimeZone: 5 } }], 'metadata-filters[0] "date-normalizing-metadata-filter": setting "defaultTimeZone" must be a string'],
  [
    "a capture group with nothing in it",
    [{ "capture-group-metadata-filter": { regex: "a", sourceField: "s", targetField: "t" } }],
    'metadata-filters[0] "capture-group-metadata-filter": the regex "a" has no capture group, and the filter writes group 1',
  ],
  ["a regex that is a number", [{ "capture-group-metadata-filter": { regex: 5, sourceField: "s", targetField: "t" } }], 'metadata-filters[0] "capture-group-metadata-filter": setting "regex" must be a string'],
  ["no regex", [{ "capture-group-metadata-filter": { sourceField: "s", targetField: "t" } }], 'metadata-filters[0] "capture-group-metadata-filter": setting "regex" is required'],
  ["no sourceField", [{ "capture-group-metadata-filter": { regex: "(a)", targetField: "t" } }], 'metadata-filters[0] "capture-group-metadata-filter": setting "sourceField" is required'],
  ["no targetField", [{ "capture-group-metadata-filter": { regex: "(a)", sourceField: "s" } }], 'metadata-filters[0] "capture-group-metadata-filter": setting "targetField" is required'],
  ["a blank sourceField", [{ "capture-group-metadata-filter": { regex: "(a)", sourceField: " ", targetField: "t" } }], "metadata-filters[0] \"capture-group-metadata-filter\": Must specify a 'sourceField'"],
  ["a blank targetField", [{ "capture-group-metadata-filter": { regex: "(a)", sourceField: "s", targetField: "" } }], "metadata-filters[0] \"capture-group-metadata-filter\": Must specify a 'targetField'"],
  ["a geoPointFieldName that is not a string", [{ "geo-point-metadata-filter": { geoPointFieldName: 1 } }], 'metadata-filters[0] "geo-point-metadata-filter": setting "geoPointFieldName" must be a string'],
  [
    "a direction in the wrong case",
    [{ "legacy-key-migration-filter": { direction: "v4_to_v3" } }],
    'metadata-filters[0] "legacy-key-migration-filter": setting "direction" must be V4_TO_V3 or V3_TO_V4',
  ],
  ["a direction that is not a string", [{ "legacy-key-migration-filter": { direction: 1 } }], 'metadata-filters[0] "legacy-key-migration-filter": setting "direction" must be V4_TO_V3 or V3_TO_V4'],
  [
    "a table of the caller's, which Tika reads from its classpath",
    [{ "legacy-key-migration-filter": { table: "/my/table.json" } }],
    'metadata-filters[0] "legacy-key-migration-filter": setting "table" names a classpath resource; ripstream ships Tika\'s table and has no classpath, so only Tika\'s own, "/org/apache/tika/metadata/metadata-migration-3x-4x.json", is accepted',
  ],
  ["a table that is not a string", [{ "legacy-key-migration-filter": { table: 1 } }], 'metadata-filters[0] "legacy-key-migration-filter": setting "table" must be a string'],
  [
    "the language filter that needs a language detector ripstream does not run in a parse",
    ["charsoup-metadata-filter"],
    'metadata-filters[0]: "charsoup-metadata-filter" is not supported: ripstream does not detect languages during a parse',
  ],
  ["Optimaize", ["optimaize-metadata-filter"], 'metadata-filters[0]: "optimaize-metadata-filter" is not supported: ripstream has no Optimaize language detector'],
  ["OpenNLP", [{ "open-nlp-metadata-filter": {} }], 'metadata-filters[0]: "open-nlp-metadata-filter" is not supported: ripstream has no OpenNLP language detector'],
  ["tika-eval", ["tika-eval-metadata-filter"], 'metadata-filters[0]: "tika-eval-metadata-filter" is not supported: ripstream has no tika-eval'],
];

for (const [what, section, expected] of REFUSALS) {
  test(`refused: ${what}`, () => {
    assert.deepEqual(issuesOf(section), [expected]);
    assert.throws(() => loadConfig({ "metadata-filters": section }), RipstreamConfigError);
  });
}

test("refused: the capture-group filter by its name alone, which gives none of its three required settings", () => {
  assert.deepEqual(issuesOf(["capture-group-metadata-filter"]), [
    'metadata-filters[0] "capture-group-metadata-filter": setting "regex" is required',
    'metadata-filters[0] "capture-group-metadata-filter": setting "sourceField" is required',
    'metadata-filters[0] "capture-group-metadata-filter": setting "targetField" is required',
  ]);
});

test("refused: a regex that is not one, and one Java reads and ripstream cannot", () => {
  for (const [regex, mention] of [["(", /\(/], ["(?x)(a)", /\(\?x\)/]] as const) {
    const issues = issuesOf([{ "capture-group-metadata-filter": { regex, sourceField: "s", targetField: "t" } }]);
    assert.equal(issues.length, 1, regex);
    assert.match(issues[0]!, /^metadata-filters\[0\] "capture-group-metadata-filter": /);
    assert.match(issues[0]!, mention);
  }
});

test("refused: a name nobody has says which names there are", () => {
  const [issue, ...rest] = issuesOf(["no-such-filter"]);
  assert.deepEqual(rest, []);
  assert.equal(issue, `metadata-filters[0]: unknown metadata filter "no-such-filter" (the filters are ${[...FILTER_NAMES].sort().join(", ")})`);
});

test("refused: a name written as Tika's class, which is not how a section names a filter", () => {
  assert.equal(issuesOf(["org.apache.tika.metadata.filter.NoOpFilter"]).length, 1);
});

test("every problem is reported, each with where it is", () => {
  const issues = issuesOf([
    "no-such-filter",
    { "include-field-metadata-filter": { include: "a", other: 1 } },
    { "capture-group-metadata-filter": {} },
    "no-op-filter",
    "optimaize-metadata-filter",
  ]);
  assert.deepEqual(
    issues.map((issue) => issue.slice(0, issue.indexOf(":"))),
    [
      "metadata-filters[0]",
      'metadata-filters[1] "include-field-metadata-filter"',
      'metadata-filters[1] "include-field-metadata-filter"',
      'metadata-filters[2] "capture-group-metadata-filter"',
      'metadata-filters[2] "capture-group-metadata-filter"',
      'metadata-filters[2] "capture-group-metadata-filter"',
      "metadata-filters[4]",
    ],
  );
});

test("a valid entry between two refused ones is still read, so nothing is reported twice", () => {
  assert.equal(issuesOf(["no-such-filter", "no-op-filter", "other-nonsense"]).length, 2);
});

test("the camelCase section is not Tika's, and is an unknown key", () => {
  assert.deepEqual(validateConfig({ metadataFilters: [] }), ['unknown top-level key "metadataFilters"']);
  assert.deepEqual(validateConfig({ metadataFilters: [{ class: "org.example.Filter" }] }), ['unknown top-level key "metadataFilters"']);
});

// The parse-context block of a configuration may carry a list as well: it is what a request's parse context carries
// in Tika, and a non-empty one replaces the top-level chain for the documents it covers.

test("parse-context accepts a metadata-filters list, kept apart from the top-level chain", () => {
  const config = loadConfig({
    "metadata-filters": [{ "include-field-metadata-filter": { include: ["a"] } }],
    "parse-context": { "metadata-filters": [{ "exclude-field-metadata-filter": { exclude: ["b"] } }] },
  });
  assert.deepEqual(config.metadataFilters, [{ name: "include-field-metadata-filter", settings: { include: ["a"] } }]);
  assert.deepEqual(config.parseContextMetadataFilters, [{ name: "exclude-field-metadata-filter", settings: { exclude: ["b"] } }]);
});

test("an empty parse-context list sets nothing, so it replaces nothing", () => {
  const config = loadConfig({ "parse-context": { "metadata-filters": [] } });
  assert.equal(config.parseContextMetadataFilters, null);
  assert.equal(config.metadataFilters, null);
});

test("parse-context reports a refused filter by where it is", () => {
  assert.deepEqual(validateConfig({ "parse-context": { "metadata-filters": [{ "no-op-filter": { a: 1 } }] } }), [
    'parse-context metadata-filters[0] "no-op-filter": setting "a" is not supported (no-op-filter takes no settings)',
  ]);
  assert.deepEqual(validateConfig({ "parse-context": { "metadata-filters": "no-op-filter" } }), ["parse-context metadata-filters must be an array"]);
});

test("a parse-context list does not make the section a limit: the limits beside it are read as before", () => {
  const config = loadConfig({
    "parse-context": {
      "metadata-filters": ["no-op-filter"],
      "output-limits": { writeLimit: 100, throwOnWriteLimit: true },
    },
  });
  assert.equal(config.limits?.maxOutputChars, 100);
  assert.equal(config.parseContextMetadataFilters?.length, 1);
});

test("a configuration with a chain still reports its other problems", () => {
  const issues = validateConfig({ "metadata-filters": ["no-op-filter"], version: 0 });
  assert.deepEqual(issues, ["version must be a positive integer"]);
});

test("every metadata filter the upstream registry lists is built or refused by name, none as unknown", () => {
  const names = UPSTREAM_COMPONENTS.filter((component) => component.kind === "metadata-filters").map((component) => component.name);
  assert.equal(names.length, 14);
  for (const name of names) {
    for (const issue of issuesOf([name])) assert.ok(!issue.includes("unknown metadata filter"), `${name}: ${issue}`);
  }
});

test("a chain cannot be built from an entry that names a filter ripstream does not have", () => {
  assert.throws(() => createMetadataFilter([{ name: "charsoup-metadata-filter", settings: {} }]), /"charsoup-metadata-filter" is not a metadata filter ripstream has/);
});

test("a configuration built by hand holds frozen copies of its entries, and an empty parse-context list is none", () => {
  const entry = { name: "include-field-metadata-filter", settings: { include: ["a"] } };
  const config = new RipstreamConfig({ metadataFilters: [entry], parseContextMetadataFilters: [] });
  entry.settings.include.push("b");
  assert.deepEqual(config.metadataFilters, [{ name: "include-field-metadata-filter", settings: { include: ["a"] } }]);
  assert.ok(Object.isFrozen(config.metadataFilters![0]!.settings.include));
  assert.equal(config.parseContextMetadataFilters, null);
  assert.equal(new RipstreamConfig().metadataFilters, null);
});

test("a parse-context list built by hand is held as frozen copies too", () => {
  const entry = { name: "exclude-field-metadata-filter", settings: { exclude: ["a"] } };
  const config = new RipstreamConfig({ parseContextMetadataFilters: [entry] });
  entry.settings.exclude.push("b");
  assert.deepEqual(config.parseContextMetadataFilters, [{ name: "exclude-field-metadata-filter", settings: { exclude: ["a"] } }]);
  assert.ok(Object.isFrozen(config.parseContextMetadataFilters));
  assert.ok(Object.isFrozen(config.parseContextMetadataFilters![0]!.settings.exclude));
});

test("a mapping with a key that is a prototype name is read as a name", () => {
  const section = JSON.parse('[{"field-name-mapping-filter":{"mappings":{"__proto__":"x","constructor":"y"},"excludeUnmapped":false}}]') as unknown;
  const document = Object.fromEntries([["__proto__", "1"], ["constructor", "2"], ["other", "3"]]);
  assert.deepEqual(run(section, document), [{ x: "1", y: "2", other: "3" }]);
});

test("the section is read into copies of what was given, and into only the entries that are right", () => {
  const include = ["a"];
  const mappings = { a: "x" };
  const { entries, issues } = parseMetadataFilterSection("metadata-filters", [
    { "include-field-metadata-filter": { include } },
    { "field-name-mapping-filter": { mappings } },
    "no-such-filter",
    "no-op-filter",
  ]);
  include.push("b");
  mappings.a = "changed";
  assert.equal(issues.length, 1);
  assert.deepEqual(entries, [
    { name: "include-field-metadata-filter", settings: { include: ["a"] } },
    { name: "field-name-mapping-filter", settings: { mappings: { a: "x" } } },
    { name: "no-op-filter", settings: {} },
  ]);
});

test("every kind of refusal leaves its entry out of what is read", () => {
  const { entries, issues } = parseMetadataFilterSection("metadata-filters", [
    "no-such-filter",
    "tika-eval-metadata-filter",
    "charsoup-metadata-filter",
    "no-op-filter",
    { "no-op-filter": { colour: "red" } },
    { "remove-by-mime-metadata-filter": { mimes: [2] } },
    { "remove-by-mime-metadata-filter": { mimes: ["not a type"] } },
    { "capture-group-metadata-filter": { regex: "(", sourceField: "a", targetField: "b" } },
    "dc:title",
  ]);
  assert.equal(issues.length, 8, issues.join("\n"));
  assert.deepEqual(entries, [{ name: "no-op-filter", settings: {} }]);
});

test("a list with something that is not a string in it is one issue, and is not given to the checks", () => {
  assert.deepEqual(issuesOf([{ "remove-by-mime-metadata-filter": { mimes: ["image/png", 2, "Image/PNG"] } }]), [
    'metadata-filters[0] "remove-by-mime-metadata-filter": setting "mimes"[1] must be a string',
  ]);
});
