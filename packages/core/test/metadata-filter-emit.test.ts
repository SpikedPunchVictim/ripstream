import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CompositeMetadataFilter,
  ExcludeFieldMetadataFilter,
  FieldNameMappingFilter,
  IncludeFieldMetadataFilter,
  MediaType,
  Metadata,
  NoOpFilter,
  RemoveByMimeMetadataFilter,
  RipstreamConfig,
  createMetadataFilter,
  emitMetadataFilter,
  filterDocument,
  filterRmetaObjects,
  metadataFiltersOf,
  rmetaObjects,
  serializeRmeta,
  type ParseRecord,
} from "../src/index.ts";

function record(fields: Record<string, string | readonly string[]>, content: string, depth: number): ParseRecord {
  const metadata = new Metadata();
  for (const [name, value] of Object.entries(fields)) for (const each of Array.isArray(value) ? value : [value]) metadata.add(name, each);
  return {
    metadata,
    content,
    embeddedResourcePath: depth === 0 ? "" : `/embedded-${depth}`,
    depth,
    mediaType: MediaType.TEXT_PLAIN,
    exception: null,
  };
}

const container = (): ParseRecord =>
  record({ "Content-Type": "application/pdf", "dc:title": "The title", "tk:parsed-by": ["Parser A", "Parser B"], "tiff:ImageWidth": "640" }, "Body text", 0);
const embedded = (): ParseRecord =>
  record({ "Content-Type": "image/png", "tk:embedded-id": "1", "tk:embedded-id-path": "/1", "tk:resource-name": "pic.png", "tiff:ImageWidth": "32" }, "", 1);

test("without a filter the objects are what they were", () => {
  const records = [container(), embedded()];
  assert.deepEqual(rmetaObjects(records, { metadataFilter: new NoOpFilter() }), rmetaObjects(records));
  assert.equal(serializeRmeta(records, { metadataFilter: new NoOpFilter() }), serializeRmeta(records));
  assert.equal(serializeRmeta(records, { metadataFilter: new NoOpFilter(), typedMetadata: true }), serializeRmeta(records, { typedMetadata: true }));
});

test("typed output types the depth as it types every integer key, filtered or not", () => {
  const [plain] = rmetaObjects([container()], { typedMetadata: true });
  const [filtered] = rmetaObjects([container()], { typedMetadata: true, metadataFilter: new NoOpFilter() });
  assert.equal(plain!["tk:embedded-depth"], 0);
  assert.equal(filtered!["tk:embedded-depth"], 0);
  assert.equal(rmetaObjects([container()])[0]!["tk:embedded-depth"], "0");
});

test("a filter sees the keys that are only made for the list: content, depth, handler, paths", () => {
  const seen: string[][] = [];
  const spy = { filter: (list: Metadata[]): void => void list.forEach((metadata) => seen.push(metadata.names())) };
  rmetaObjects([container(), embedded()], { metadataFilter: spy });
  assert.ok(seen[0]!.includes("tk:content"));
  assert.ok(seen[0]!.includes("tk:content-handler-type"));
  assert.ok(seen[0]!.includes("tk:embedded-depth"));
  assert.ok(seen[0]!.includes("tk:parsed-by-full-set"));
  assert.ok(seen[1]!.includes("tk:final-embedded-resource-path"));
  assert.ok(!seen[1]!.includes("tk:content"), "blank content is not a key");
});

test("include-field keeps what it names, on every document", () => {
  const filter = new IncludeFieldMetadataFilter({ include: ["tk:content", "Content-Type"] });
  assert.deepEqual(rmetaObjects([container(), embedded()], { metadataFilter: filter }), [
    { "Content-Type": "application/pdf", "tk:content": "Body text" },
    { "Content-Type": "image/png" },
  ]);
});

test("a filter that takes documents out of the list takes them out of the answer", () => {
  const filter = new RemoveByMimeMetadataFilter({ mimes: ["image/png"] });
  const objects = rmetaObjects([container(), embedded()], { metadataFilter: filter });
  assert.equal(objects.length, 1);
  assert.equal(objects[0]!["Content-Type"], "application/pdf");
  assert.equal(JSON.parse(serializeRmeta([container(), embedded()], { metadataFilter: filter })).length, 1);
});

test("typed values are typed after the filter, and a value the filter wrote is typed too", () => {
  const filter = new ExcludeFieldMetadataFilter({ exclude: ["tk:content"] });
  const [typed] = rmetaObjects([container()], { metadataFilter: filter, typedMetadata: true });
  assert.equal(typed!["tiff:ImageWidth"], 640);
  assert.equal(typed!["tk:content"], undefined);
});

test("a filter reads the values as they were written, whether or not the output is typed", () => {
  const seen: Array<string | null> = [];
  const spy = { filter: (list: Metadata[]): void => void seen.push(list[0]!.get("tiff:ImageWidth")) };
  const padded = record({ "tiff:ImageWidth": "0640" }, "", 0);
  const [typed] = rmetaObjects([padded], { metadataFilter: spy, typedMetadata: true });
  assert.deepEqual(seen, ["0640"]);
  assert.equal(typed!["tiff:ImageWidth"], 640);
});

test("multiple values stay multiple, in order", () => {
  const [object] = rmetaObjects([container()], { metadataFilter: new ExcludeFieldMetadataFilter({ exclude: ["tk:content"] }) });
  assert.deepEqual(object!["tk:parsed-by"], ["Parser A", "Parser B"]);
});

test("the document shape of the serialization is the first document left", () => {
  const filter = new RemoveByMimeMetadataFilter({ mimes: ["application/pdf"] });
  const json = JSON.parse(serializeRmeta([container(), embedded()], { metadataFilter: filter, jsonShape: "document" })) as Record<string, string>;
  assert.equal(json["Content-Type"], "image/png");
});

test("the records and the objects given are not changed by a filter", () => {
  const records = [container(), embedded()];
  const before = rmetaObjects(records);
  rmetaObjects(records, { metadataFilter: new IncludeFieldMetadataFilter({ include: [] }) });
  assert.deepEqual(rmetaObjects(records), before);
  const objects = [{ a: "1", b: ["2", "3"] }];
  filterRmetaObjects(objects, new ExcludeFieldMetadataFilter({ exclude: ["a"] }));
  assert.deepEqual(objects, [{ a: "1", b: ["2", "3"] }]);
});

test("numbers and booleans given to the filter are its text", () => {
  const out = filterRmetaObjects([{ n: 5, flag: true, list: [1, 2] }] as never, new NoOpFilter());
  assert.deepEqual(out, [{ n: "5", flag: "true", list: ["1", "2"] }]);
});

test("a filter that fails is not swallowed", () => {
  const broken = { filter: (): void => { throw new Error("filter failed"); } };
  assert.throws(() => rmetaObjects([container()], { metadataFilter: broken }), /filter failed/);
});

test("filterDocument: content is tk:content for the filter", () => {
  const document = { metadata: { "dc:title": "T", "Content-Type": "text/plain" }, text: "the content" };
  assert.deepEqual(filterDocument(new IncludeFieldMetadataFilter({ include: ["dc:title"] }), document), { metadata: { "dc:title": "T" }, text: "" });
  assert.deepEqual(filterDocument(new IncludeFieldMetadataFilter({ include: ["tk:content"] }), document), { metadata: {}, text: "the content" });
  assert.deepEqual(filterDocument(new ExcludeFieldMetadataFilter({ exclude: ["dc:title"] }), document), {
    metadata: { "Content-Type": "text/plain" },
    text: "the content",
  });
});

test("filterDocument: blank content is no key, and a document taken out of the list is nothing", () => {
  const seen: string[] = [];
  const spy = { filter: (list: Metadata[]): void => void seen.push(...list.flatMap((metadata) => metadata.names())) };
  filterDocument(spy, { metadata: { a: "1" }, text: "  \n" });
  assert.deepEqual(seen, ["a"]);
  assert.deepEqual(filterDocument(new RemoveByMimeMetadataFilter({ mimes: ["text/plain"] }), { metadata: { "Content-Type": "text/plain" }, text: "x" }), {
    metadata: {},
    text: "",
  });
});

test("filterDocument: a tk:content key in the metadata is replaced by the text, and the input is not changed", () => {
  const metadata = { "tk:content": "stale", a: "1" };
  const out = filterDocument(new NoOpFilter(), { metadata, text: "fresh" });
  assert.equal(out.text, "fresh");
  assert.deepEqual(out.metadata, { a: "1" });
  assert.deepEqual(metadata, { "tk:content": "stale", a: "1" });
});

test("filterDocument: a stale tk:content in the metadata does not stand for blank content", () => {
  const out = filterDocument(new NoOpFilter(), { metadata: { "tk:content": "stale", a: "1" }, text: "" });
  assert.deepEqual(out, { metadata: { a: "1" }, text: "" });
});

test("filterDocument: content a filter made of several values is the first of them, as Tika's get is", () => {
  const merged = new FieldNameMappingFilter({ mappings: { extra: "tk:content" }, excludeUnmapped: false });
  const out = filterDocument(merged, { metadata: { extra: "more" }, text: "main" });
  assert.equal(out.text, "main");
  assert.deepEqual(out.metadata, {});
});

const include = new IncludeFieldMetadataFilter({ include: ["dc:title"] });
const exclude = new ExcludeFieldMetadataFilter({ exclude: ["dc:title"] });

test("emitMetadataFilter: the parse-context filter, else CONTENT_ONLY's own, else the configured chain", () => {
  assert.equal(emitMetadataFilter({ configured: include, parseContext: exclude }, false), exclude);
  assert.equal(emitMetadataFilter({ configured: include, parseContext: exclude }, true), exclude);
  assert.equal(emitMetadataFilter({ configured: include }, false), include);
  assert.equal(emitMetadataFilter({ configured: include, parseContext: null }, false), include);
  assert.equal(emitMetadataFilter({}, false), null);
  assert.equal(emitMetadataFilter(undefined, false), null);
  assert.equal(emitMetadataFilter(undefined, true) !== null, true);
});

test("emitMetadataFilter: CONTENT_ONLY does not consult the configured chain, and keeps the content and the container exception", () => {
  const filter = emitMetadataFilter({ configured: exclude }, true)!;
  assert.notEqual(filter, exclude);
  const out = filterDocument(filter, {
    metadata: { "dc:title": "T", "tk:exception:container-exception": "Boom: bad", "Content-Type": "text/plain" },
    text: "words",
  });
  assert.deepEqual(out, { metadata: { "tk:exception:container-exception": "Boom: bad" }, text: "words" });
});

test("emitMetadataFilter: a no-op filter is none, in the parse context too, which then keeps CONTENT_ONLY's default away", () => {
  assert.equal(emitMetadataFilter({ configured: new NoOpFilter() }, false), null);
  assert.equal(emitMetadataFilter({ configured: include, parseContext: new NoOpFilter() }, false), null);
  assert.equal(emitMetadataFilter({ parseContext: new NoOpFilter() }, true), null);
});

test("metadataFiltersOf builds both chains from a configuration, and none from one without", () => {
  assert.deepEqual(metadataFiltersOf(new RipstreamConfig()), { configured: null, parseContext: null });
  const config = new RipstreamConfig({
    metadataFilters: [{ name: "include-field-metadata-filter", settings: { include: ["a"] } }],
    parseContextMetadataFilters: [{ name: "exclude-field-metadata-filter", settings: { exclude: ["a"] } }],
  });
  const { configured, parseContext } = metadataFiltersOf(config);
  assert.ok(configured instanceof CompositeMetadataFilter);
  assert.ok(parseContext instanceof CompositeMetadataFilter);
  const list = (filter: typeof configured): Record<string, string | readonly string[]>[] => filterRmetaObjects([{ a: "1", b: "2" }], filter!);
  assert.deepEqual(list(configured), [{ a: "1" }]);
  assert.deepEqual(list(parseContext), [{ b: "2" }]);
  assert.ok(createMetadataFilter([]) instanceof NoOpFilter);
});
