import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaType,
  Metadata,
  markParseTiming,
  rmetaObject,
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

test("serializes records depth-first with arrays and content", () => {
  const records = [
    record("/doc", 0, { "Content-Type": ["application/zip"] }, "root"),
    record("/doc/a.txt", 1, { "Content-Type": ["text/plain"] }, "child"),
  ];
  const parsed = JSON.parse(serializeRmeta(records)) as Array<
    Record<string, unknown>
  >;
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]?.["Content-Type"], ["application/zip"]);
  assert.equal(parsed[0]?.["X-TIKA:content"], "root");
  assert.deepEqual(parsed[1]?.["X-TIKA:embedded_resource_path"], [
    "/doc/a.txt",
  ]);
  assert.deepEqual(parsed[1]?.["X-TIKA:embedded_depth"], ["1"]);
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

test("document shape emits the first record and exceptions", () => {
  const entry = record("/doc", 0, {}, "body");
  entry.exception = new Error("boom");
  entry.exception.name = "MalformedDocumentError";
  const parsed = JSON.parse(
    serializeRmeta([entry], { jsonShape: "document" }),
  ) as Record<string, unknown>;
  assert.equal(parsed["X-TIKA:content"], "body");
  assert.deepEqual(parsed["X-TIKA:EXCEPTION:MalformedDocumentError"], ["boom"]);
});

test("parse timing is recorded", () => {
  const metadata = new Metadata();
  markParseTiming(metadata, performance.now());
  assert.match(metadata.get("X-TIKA:parse_time_millis") ?? "", /^\d+$/);
});
