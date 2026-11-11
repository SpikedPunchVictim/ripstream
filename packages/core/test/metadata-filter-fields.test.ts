import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CaptureGroupMetadataFilter,
  ClearByAttachmentTypeMetadataFilter,
  EMBEDDED_RESOURCE_TYPES,
  FieldNameMappingFilter,
  GeoPointMetadataFilter,
  Metadata,
  ParseContext,
  RemoveByMimeMetadataFilter,
  TIKA_KEYS,
  type MetadataFilter,
} from "../src/index.ts";

function metadataOf(values: Record<string, string | string[]>): Metadata {
  const metadata = new Metadata();
  for (const [name, value] of Object.entries(values)) {
    for (const each of Array.isArray(value) ? value : [value]) metadata.add(name, each);
  }
  return metadata;
}

function run(filter: MetadataFilter, ...list: Metadata[]): Metadata[] {
  filter.filter(list, new ParseContext());
  return list;
}

function snapshot(metadata: Metadata): Record<string, string[]> {
  return Object.fromEntries(metadata.names().sort().map((name) => [name, [...metadata.getAll(name)]]));
}

// --- FieldNameMappingFilter

test("field mapping keeps only the mapped names, under their new names, by default", () => {
  const [metadata] = run(
    new FieldNameMappingFilter({
      mappings: { "tk:content": "content", "Content-Type": "mime", "dc:title": "title", "dc:creator": "author" },
    }),
    metadataOf({ "tk:content": "text", "Content-Type": "text/plain", "dc:title": "T", "pdf:producer": "P" }),
  );
  assert.deepEqual(snapshot(metadata!), { content: ["text"], mime: ["text/plain"], title: ["T"] });
});

test("field mapping with excludeUnmapped false renames the mapped names and keeps the others", () => {
  const [metadata] = run(
    new FieldNameMappingFilter({ mappings: { "dc:title": "title" }, excludeUnmapped: false }),
    metadataOf({ "dc:title": "T", "pdf:producer": "P" }),
  );
  assert.deepEqual(snapshot(metadata!), { "pdf:producer": ["P"], title: ["T"] });
});

test("field mapping carries every value of a renamed name, in order", () => {
  const [metadata] = run(
    new FieldNameMappingFilter({ mappings: { "dc:subject": "subject" } }),
    metadataOf({ "dc:subject": ["x", "y", "z"] }),
  );
  assert.deepEqual(metadata!.getAll("subject"), ["x", "y", "z"]);
});

test("field mapping onto a name the document has appends to its values", () => {
  const [metadata] = run(
    new FieldNameMappingFilter({ mappings: { a: "b" }, excludeUnmapped: false }),
    metadataOf({ a: "1", b: "2" }),
  );
  assert.deepEqual(snapshot(metadata!), { b: ["2", "1"] });
});

test("field mapping a name to itself keeps its values", () => {
  const [metadata] = run(
    new FieldNameMappingFilter({ mappings: { a: "a" } }),
    metadataOf({ a: ["1", "2"], b: "3" }),
  );
  assert.deepEqual(snapshot(metadata!), { a: ["1", "2"] });
});

test("field mapping with no mappings empties every document by default, as Tika's does", () => {
  const list = run(new FieldNameMappingFilter({ mappings: {} }), metadataOf({ a: "1" }), metadataOf({ b: "2" }));
  assert.deepEqual(list.map(snapshot), [{}, {}]);
});

test("field mapping with no mappings and excludeUnmapped false changes nothing", () => {
  const [metadata] = run(new FieldNameMappingFilter({ mappings: {}, excludeUnmapped: false }), metadataOf({ a: "1" }));
  assert.deepEqual(snapshot(metadata!), { a: ["1"] });
});

test("field mapping maps every document of the list", () => {
  const list = run(
    new FieldNameMappingFilter({ mappings: { a: "x" } }),
    metadataOf({ a: "1", b: "2" }),
    metadataOf({ a: "3" }),
  );
  assert.deepEqual(list.map(snapshot), [{ x: ["1"] }, { x: ["3"] }]);
});

test("field mapping copies the mappings it is given", () => {
  const mappings: Record<string, string> = { a: "x" };
  const filter = new FieldNameMappingFilter({ mappings });
  mappings.b = "y";
  const [metadata] = run(filter, metadataOf({ a: "1", b: "2" }));
  assert.deepEqual(snapshot(metadata!), { x: ["1"] });
});

test("field mapping reads a name like __proto__ as any other name", () => {
  const mappings = JSON.parse('{"__proto__":"x","constructor":"y"}') as Record<string, string>;
  const input = new Metadata();
  input.add("__proto__", "1");
  input.add("constructor", "2");
  input.add("toString", "3");
  const [metadata] = run(new FieldNameMappingFilter({ mappings }), input);
  assert.deepEqual(snapshot(metadata!), { x: ["1"], y: ["2"] });
});

// --- CaptureGroupMetadataFilter

test("capture group strips the parameters off a media type, with Tika's own pattern", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "Content-Type", targetField: "Content-Type", regex: "\\A([^;]+)" }),
    metadataOf({ "Content-Type": "text/plain; charset=UTF-8" }),
  );
  assert.deepEqual(metadata!.getAll("Content-Type"), ["text/plain"]);
});

test("capture group writes the first group of the first match", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "(\\d+)-(\\d+)" }),
    metadataOf({ s: "ab 12-34 cd 56-78" }),
  );
  assert.deepEqual(snapshot(metadata!), { s: ["ab 12-34 cd 56-78"], t: ["12"] });
});

test("capture group with no match leaves the target as it was", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "(\\d+)" }),
    metadataOf({ s: "none", t: "kept" }),
  );
  assert.deepEqual(snapshot(metadata!), { s: ["none"], t: ["kept"] });
});

test("capture group with no source field does nothing, and makes no target", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "(.*)" }),
    metadataOf({ other: "x" }),
  );
  assert.deepEqual(snapshot(metadata!), { other: ["x"] });
});

test("capture group with a blank source value does nothing", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "(.*)" }),
    metadataOf({ s: " \t\n" }),
    metadataOf({ s: "" }),
  );
  assert.deepEqual(snapshot(metadata!), { s: [" \t\n"] });
});

test("capture group does not take a no-break space for blank, as Java does not", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "^(.)$" }),
    metadataOf({ s: " " }),
  );
  assert.deepEqual(metadata!.getAll("t"), [" "]);
});

test("capture group reads only the first value of the source", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "(\\w+)" }),
    metadataOf({ s: ["first", "second"] }),
  );
  assert.deepEqual(metadata!.getAll("t"), ["first"]);
});

test("capture group replaces every value the target had", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "(\\w+)" }),
    metadataOf({ s: "new", t: ["old1", "old2"] }),
  );
  assert.deepEqual(metadata!.getAll("t"), ["new"]);
});

test("capture group with the source as the target replaces all of the source's values", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "s", regex: "(\\w+)" }),
    metadataOf({ s: ["one two", "three"] }),
  );
  assert.deepEqual(metadata!.getAll("s"), ["one"]);
});

test("capture group removes the target when the match leaves group 1 out, as Tika's null write does", () => {
  const [metadata] = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "(a)|b" }),
    metadataOf({ s: "b", t: "old" }),
  );
  assert.deepEqual(snapshot(metadata!), { s: ["b"] });
});

test("capture group applies to each document of the list on its own", () => {
  const list = run(
    new CaptureGroupMetadataFilter({ sourceField: "s", targetField: "t", regex: "(\\d+)" }),
    metadataOf({ s: "a1" }),
    metadataOf({ s: "none" }),
    metadataOf({ s: "b22" }),
  );
  assert.deepEqual(list.map((m) => m.get("t")), ["1", null, "22"]);
});

test("capture group refuses what Tika's refuses: a blank source or target, and a regex that does not compile", () => {
  const ok = { sourceField: "s", targetField: "t", regex: "(x)" };
  assert.throws(() => new CaptureGroupMetadataFilter({ ...ok, sourceField: " " }), /Must specify a 'sourceField'/);
  assert.throws(() => new CaptureGroupMetadataFilter({ ...ok, targetField: "" }), /Must specify a 'targetField'/);
  assert.throws(() => new CaptureGroupMetadataFilter({ ...ok, regex: "(" }), /not a valid regular expression "\("/);
});

test("capture group refuses a regex that is missing, or has no group to capture", () => {
  const ok = { sourceField: "s", targetField: "t", regex: "(x)" };
  assert.throws(() => new CaptureGroupMetadataFilter({ ...ok, regex: undefined as never }), /Must specify a 'regex'/);
  assert.throws(() => new CaptureGroupMetadataFilter({ ...ok, regex: "x" }), /has no capture group/);
  assert.throws(() => new CaptureGroupMetadataFilter({ ...ok, regex: "(?:x)" }), /has no capture group/);
  assert.throws(() => new CaptureGroupMetadataFilter({ ...ok, regex: "\\(x\\)" }), /has no capture group/);
  assert.doesNotThrow(() => new CaptureGroupMetadataFilter({ ...ok, regex: "(?<name>x)" }));
});

// --- ClearByAttachmentTypeMetadataFilter

test("clear by attachment type empties, but keeps, a document whose type is one it is given", () => {
  const list = run(
    new ClearByAttachmentTypeMetadataFilter({ types: ["INLINE"] }),
    metadataOf({ "Content-Type": "application/pdf" }),
    metadataOf({ [TIKA_KEYS.EMBEDDED_RESOURCE_TYPE]: "INLINE", "Content-Type": "image/png", a: ["1", "2"] }),
    metadataOf({ [TIKA_KEYS.EMBEDDED_RESOURCE_TYPE]: "ATTACHMENT", "Content-Type": "text/plain" }),
  );
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(snapshot), [
    { "Content-Type": ["application/pdf"] },
    {},
    { [TIKA_KEYS.EMBEDDED_RESOURCE_TYPE]: ["ATTACHMENT"], "Content-Type": ["text/plain"] },
  ]);
});

test("clear by attachment type with no types changes nothing", () => {
  const [metadata] = run(
    new ClearByAttachmentTypeMetadataFilter({ types: [] }),
    metadataOf({ [TIKA_KEYS.EMBEDDED_RESOURCE_TYPE]: "INLINE" }),
  );
  assert.equal(metadata!.size(), 1);
});

test("clear by attachment type reads a type as it is spelled, so 'inline' is not 'INLINE'", () => {
  const [metadata] = run(
    new ClearByAttachmentTypeMetadataFilter({ types: ["INLINE", "MACRO"] }),
    metadataOf({ [TIKA_KEYS.EMBEDDED_RESOURCE_TYPE]: "inline" }),
  );
  assert.equal(metadata!.size(), 1);
});

test("clear by attachment type takes every type Tika has, and no other", () => {
  assert.deepEqual([...EMBEDDED_RESOURCE_TYPES], [
    "INLINE", "ATTACHMENT", "MACRO", "METADATA", "FONT", "THUMBNAIL", "RENDERING", "VERSION", "ALTERNATE_FORMAT_CHUNK",
  ]);
  assert.doesNotThrow(() => new ClearByAttachmentTypeMetadataFilter({ types: [...EMBEDDED_RESOURCE_TYPES] }));
});

test("clear by attachment type refuses a type it does not know, and lists the ones it does", () => {
  assert.throws(
    () => new ClearByAttachmentTypeMetadataFilter({ types: ["INLINE", "inline"] }),
    /"inline".*INLINE, ATTACHMENT, MACRO, METADATA, FONT, THUMBNAIL, RENDERING, VERSION, ALTERNATE_FORMAT_CHUNK/,
  );
});

test("clear by attachment type copies the types it is given", () => {
  const types = ["INLINE"];
  const filter = new ClearByAttachmentTypeMetadataFilter({ types });
  types.push("MACRO");
  const [metadata] = run(filter, metadataOf({ [TIKA_KEYS.EMBEDDED_RESOURCE_TYPE]: "MACRO" }));
  assert.equal(metadata!.size(), 1);
});

// --- RemoveByMimeMetadataFilter

test("remove by mime takes a document out of the list when its base type is one it is given", () => {
  const list = [
    metadataOf({ id: "container", "Content-Type": "application/pdf" }),
    metadataOf({ id: "png", "Content-Type": "image/png" }),
    metadataOf({ id: "text", "Content-Type": "text/plain; charset=UTF-8" }),
    metadataOf({ id: "jpeg", "Content-Type": "image/jpeg" }),
  ];
  new RemoveByMimeMetadataFilter({ mimes: ["image/png", "image/jpeg"] }).filter(list, new ParseContext());
  assert.deepEqual(list.map((m) => m.get("id")), ["container", "text"]);
});

test("remove by mime changes the array it is given, not a copy", () => {
  const list = [metadataOf({ "Content-Type": "image/png" }), metadataOf({ "Content-Type": "text/plain" })];
  const same = list;
  new RemoveByMimeMetadataFilter({ mimes: ["image/png"] }).filter(list, new ParseContext());
  assert.equal(same.length, 1);
});

test("remove by mime reads the base type, so a parameter does not stop a match and a case does not either", () => {
  const list = [
    metadataOf({ "Content-Type": "image/png; foo=bar" }),
    metadataOf({ "Content-Type": "IMAGE/PNG" }),
  ];
  new RemoveByMimeMetadataFilter({ mimes: ["image/png"] }).filter(list, new ParseContext());
  assert.equal(list.length, 0);
});

test("remove by mime compares to the name it was given exactly, so 'Image/PNG' removes nothing", () => {
  const list = [metadataOf({ "Content-Type": "image/png" })];
  new RemoveByMimeMetadataFilter({ mimes: ["Image/PNG"] }).filter(list, new ParseContext());
  assert.equal(list.length, 1);
});

test("remove by mime keeps a document with no Content-Type, or one that is not a media type", () => {
  const list = [metadataOf({ a: "1" }), metadataOf({ "Content-Type": "garbage" }), metadataOf({ "Content-Type": "" })];
  new RemoveByMimeMetadataFilter({ mimes: ["garbage", ""] }).filter(list, new ParseContext());
  assert.equal(list.length, 3);
});

test("remove by mime may take the container out, and a run of documents", () => {
  const list = [
    metadataOf({ id: "0", "Content-Type": "image/png" }),
    metadataOf({ id: "1", "Content-Type": "image/png" }),
    metadataOf({ id: "2", "Content-Type": "image/png" }),
    metadataOf({ id: "3", "Content-Type": "text/plain" }),
    metadataOf({ id: "4", "Content-Type": "image/png" }),
  ];
  new RemoveByMimeMetadataFilter({ mimes: ["image/png"] }).filter(list, new ParseContext());
  assert.deepEqual(list.map((m) => m.get("id")), ["3"]);
});

test("remove by mime with no mimes changes nothing", () => {
  const list = [metadataOf({ "Content-Type": "image/png" })];
  new RemoveByMimeMetadataFilter({ mimes: [] }).filter(list, new ParseContext());
  assert.equal(list.length, 1);
});

test("remove by mime copies the mimes it is given", () => {
  const mimes = ["image/png"];
  const filter = new RemoveByMimeMetadataFilter({ mimes });
  mimes.push("text/plain");
  const list = [metadataOf({ "Content-Type": "text/plain" })];
  filter.filter(list, new ParseContext());
  assert.equal(list.length, 1);
});

// --- GeoPointMetadataFilter

test("geo point joins latitude and longitude into 'location', and keeps both", () => {
  const [metadata] = run(new GeoPointMetadataFilter({}), metadataOf({ "geo:lat": "48.85", "geo:long": "2.35" }));
  assert.deepEqual(snapshot(metadata!), { "geo:lat": ["48.85"], "geo:long": ["2.35"], location: ["48.85,2.35"] });
});

test("geo point writes the field it is told to", () => {
  const [metadata] = run(
    new GeoPointMetadataFilter({ geoPointFieldName: "tk:geo-point" }),
    metadataOf({ "geo:lat": "1", "geo:long": "2" }),
  );
  assert.equal(metadata!.get("tk:geo-point"), "1,2");
  assert.equal(metadata!.get("location"), null);
});

test("geo point needs both, and a non-empty one of each", () => {
  const list = run(
    new GeoPointMetadataFilter({}),
    metadataOf({ "geo:lat": "1" }),
    metadataOf({ "geo:long": "2" }),
    metadataOf({ "geo:lat": "", "geo:long": "2" }),
    metadataOf({ "geo:lat": "1", "geo:long": "" }),
    metadataOf({}),
  );
  assert.deepEqual(list.map((m) => m.get("location")), [null, null, null, null, null]);
});

test("geo point reads the first value of each, and replaces what 'location' held", () => {
  const [metadata] = run(
    new GeoPointMetadataFilter({}),
    metadataOf({ "geo:lat": ["1", "9"], "geo:long": ["2", "8"], location: ["old1", "old2"] }),
  );
  assert.deepEqual(metadata!.getAll("location"), ["1,2"]);
});

test("geo point does not take a blank (but not empty) value for empty", () => {
  const [metadata] = run(new GeoPointMetadataFilter({}), metadataOf({ "geo:lat": " ", "geo:long": "2" }));
  assert.equal(metadata!.get("location"), " ,2");
});

test("geo point applies to each document of the list", () => {
  const list = run(
    new GeoPointMetadataFilter({}),
    metadataOf({ "geo:lat": "1", "geo:long": "2" }),
    metadataOf({ a: "x" }),
    metadataOf({ "geo:lat": "3", "geo:long": "4" }),
  );
  assert.deepEqual(list.map((m) => m.get("location")), ["1,2", null, "3,4"]);
});

test("geo point with the default name is 'location'", () => {
  const [metadata] = run(new GeoPointMetadataFilter(), metadataOf({ "geo:lat": "1", "geo:long": "2" }));
  assert.equal(metadata!.get("location"), "1,2");
});
