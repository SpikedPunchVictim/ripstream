import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";

/*
 * The name a detector is hinted with comes from `tk:resource-name`, or failing that from a Content-Disposition header.
 * A file named `filenames.csv` is a name, not a header that has no filename in it.
 */

const CSV = new TextEncoder().encode("a,b,c\n1,2,3\n4,5,6\n");

async function detect(metadata: Record<string, string>): Promise<string> {
  const given = new Metadata();
  for (const [key, value] of Object.entries(metadata)) given.set(key, value);
  const type = await new DefaultDetector().detect(await RipstreamInputStream.from(CSV), given, new ParseContext());
  return type.toString();
}

test("a resource name that has the letters filename in it is still a name", async () => {
  assert.equal(await detect({ "tk:resource-name": "data.csv" }), "text/csv");
  assert.equal(await detect({ "tk:resource-name": "filenames.csv" }), "text/csv");
  assert.equal(await detect({ "tk:resource-name": "my_filename_map.csv" }), "text/csv");
});

test("a Content-Disposition header names the file by its filename parameter", async () => {
  assert.equal(await detect({ "Content-Disposition": 'attachment; filename="data.csv"' }), "text/csv");
  assert.equal(await detect({ "Content-Disposition": "attachment; filename=filenames.csv" }), "text/csv");
});

test("a raw Content-Disposition value given as the resource name is still read as the header it is", async () => {
  assert.equal(await detect({ "tk:resource-name": 'attachment; filename="data.csv"' }), "text/csv");
});

// Tika 4.2.0 /meta with filename "DATA.CSV" on CSV text: text/csv (the name is retried in lower case), and "data.csv?x=1" too.
test("an upper-case extension and a name with a query still hint the type", async () => {
  assert.equal(await detect({ "tk:resource-name": "DATA.CSV" }), "text/csv");
  assert.equal(await detect({ "tk:resource-name": "data.csv?x=1" }), "text/csv");
});
