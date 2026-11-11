import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRipstream } from "../src/index.ts";

/*
 * What the JSON fixtures in fixtures/archive-samples cannot say: the embedded documents of Tika 4.2.0's own GeoGebra
 * and WACZ files (GeoGebraParserTest, WACZParserTest). Read from the Tika source, not run against a Tika (tikajs-68os.52).
 */

const ripstream = createRipstream();

function sample(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`./fixtures/archive-samples/${name}`, import.meta.url)));
}

test("testGeoGebra.ggb: the container, a thumbnail and the document script", async () => {
  const records = await ripstream.parseRecursive(sample("testGeoGebra.ggb"), { filename: "testGeoGebra.ggb" });
  assert.equal(records.length, 3);
  assert.equal(records[0]?.metadata.get("Content-Type"), "application/vnd.geogebra.file");
  const thumbnail = records.find((r) => r.metadata.get("tk:resource-name") === "geogebra_thumbnail.png");
  assert.equal(thumbnail?.metadata.get("Content-Type"), "image/png");
  assert.equal(thumbnail?.metadata.get("tk:embedded-resource-type"), "THUMBNAIL");
  const script = records.find((r) => r.metadata.get("tk:resource-name") === "geogebra_javascript.js");
  assert.equal(script?.metadata.get("tk:embedded-resource-type"), "MACRO");
});

test("testGeoGebra_classic.ggb: the container and the document script", async () => {
  const records = await ripstream.parseRecursive(sample("testGeoGebra_classic.ggb"), { filename: "testGeoGebra_classic.ggb" });
  assert.equal(records.length, 2);
  const script = records.find((r) => r.metadata.get("tk:resource-name") === "geogebra_javascript.js");
  assert.equal(script?.metadata.get("tk:embedded-resource-type"), "MACRO");
});

test("testWACZ.wacz: the container is a WACZ and its one embedded document a WARC", async () => {
  const records = await ripstream.parseRecursive(sample("testWACZ.wacz"), { filename: "testWACZ.wacz" });
  assert.equal(records.length, 2);
  assert.equal(records[0]?.metadata.get("Content-Type"), "application/x-wacz");
  assert.equal(records[1]?.metadata.get("Content-Type"), "application/warc");
});
