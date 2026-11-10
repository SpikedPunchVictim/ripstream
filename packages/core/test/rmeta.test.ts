import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaType,
  Metadata,
  markParseTiming,
  rmetaObject,
  rmetaObjects,
  serializeRmeta,
  type ParseRecord,
} from "../src/index.ts";

function record(
  path: string,
  depth: number,
  values: Record<string, string[]>,
  content: string,
): ParseRecord {
  const metadata = new Metadata();
  for (const [key, list] of Object.entries(values)) {
    for (const value of list) metadata.add(key, value);
  }
  return {
    metadata,
    content,
    embeddedResourcePath: path,
    depth,
    mediaType: MediaType.TEXT_PLAIN,
    exception: null,
  };
}

test("serializes records depth-first: a key with one value is a string, with several an array", () => {
  const records = [
    record("/doc", 0, { "Content-Type": ["application/zip"], "dc:creator": ["A", "B"] }, "root"),
    record("/doc/a.txt", 1, { "Content-Type": ["text/plain"], "tk:embedded-resource-path": ["/a.txt"] }, "child"),
  ];
  const parsed = JSON.parse(serializeRmeta(records)) as Array<
    Record<string, unknown>
  >;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.["Content-Type"], "application/zip");
  assert.deepEqual(parsed[0]?.["dc:creator"], ["A", "B"]);
  assert.equal(parsed[0]?.["tk:content"], "root");
  assert.equal(parsed[0]?.["tk:content-handler-type"], "TEXT");
  assert.equal(parsed[0]?.["tk:embedded-depth"], "0");
  assert.equal(parsed[0]?.["tk:embedded-resource-path"], undefined, "the container has no embedded path");
  assert.equal(parsed[1]?.["tk:embedded-resource-path"], "/a.txt");
  assert.equal(parsed[1]?.["tk:embedded-depth"], "1");
});

test("content is added only when it is not blank, as Tika does", () => {
  const blank = rmetaObject(record("/doc", 0, {}, " \n "));
  assert.equal(blank["tk:content"], undefined);
  assert.equal(blank["tk:content-handler-type"], undefined);
  assert.equal(rmetaObject(record("/doc", 0, {}, "x"), { includeContent: false })["tk:content"], undefined);
});

test("rmetaObjects adds the keys that need the whole list: parsed-by-full-set and final embedded paths", () => {
  const records = [
    record("/doc", 0, { "tk:parsed-by": ["ZipParser"] }, ""),
    record("/doc/a.zip", 1, { "tk:embedded-id": ["1"], "tk:embedded-id-path": ["/1"], "tk:resource-name": ["a.zip"], "tk:parsed-by": ["ZipParser"] }, ""),
    record("/doc/a.zip/b.txt", 2, { "tk:embedded-id": ["2"], "tk:embedded-id-path": ["/1/2"], "tk:resource-name": ["dir/b.txt"], "tk:parsed-by": ["TextParser"] }, "b"),
  ];
  const objects = rmetaObjects(records);
  assert.deepEqual(objects[0]?.["tk:parsed-by-full-set"], ["ZipParser", "TextParser"]);
  assert.equal(objects[0]?.["tk:final-embedded-resource-path"], undefined);
  assert.equal(objects[1]?.["tk:final-embedded-resource-path"], "/a.zip");
  assert.equal(objects[2]?.["tk:final-embedded-resource-path"], "/a.zip/b.txt", "a name with a path keeps its last segment");
});

test("typed metadata collapses singletons using the schema", () => {
  const entry = record(
    "/doc",
    0,
    {
      "meta:page-count": ["3"],
      "pdf:encrypted": ["true"],
      "dc:title": ["A"],
      "custom:any": ["x"],
    },
    "",
  );
  const value = rmetaObject(entry, { typedMetadata: true });
  assert.equal(value["meta:page-count"], 3);
  assert.equal(value["dc:title"], "A");
  assert.equal(value["custom:any"], "x");
});

test("document shape emits the first record and the container exception", () => {
  const entry = record("/doc", 0, {}, "body");
  entry.exception = new Error("boom");
  entry.exception.name = "MalformedDocumentError";
  const parsed = JSON.parse(
    serializeRmeta([entry], { jsonShape: "document" }),
  ) as Record<string, unknown>;
  assert.equal(parsed["tk:content"], "body");
  assert.equal(parsed["tk:exception:container-exception"], "MalformedDocumentError: boom");
});

test("an exception already noted on the metadata is not noted twice", () => {
  const entry = record("/doc", 0, { "tk:exception:container-exception": ["MalformedDocumentError: boom"] }, "");
  entry.exception = Object.assign(new Error("boom"), { name: "MalformedDocumentError" });
  assert.equal(rmetaObject(entry)["tk:exception:container-exception"], "MalformedDocumentError: boom");
});

test("parse timing is recorded", () => {
  const metadata = new Metadata();
  markParseTiming(metadata, performance.now());
  assert.match(metadata.get("tk:parse-time-millis") ?? "", /^\d+$/);
});
