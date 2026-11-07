import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType, ParseContext } from "@spikedpunch/ripstream-core";
import { createDefaultParser } from "../src/index.ts";

async function supporters(type: string): Promise<string[]> {
  const parser = createDefaultParser() as unknown as {
    getParsers(): readonly import("@spikedpunch/ripstream-core").Parser[];
  };
  const ctx = new ParseContext();
  const wanted = MediaType.parseOrThrow(type);
  const names: string[] = [];
  for (const candidate of parser.getParsers()) {
    const types = await candidate.getSupportedTypes(ctx);
    if ([...types].some((supported) => supported.equals(wanted))) names.push(candidate.name);
  }
  return names;
}

test("types the detector emits reach a parser", async () => {
  assert.deepEqual(await supporters("application/x-matroska"), ["MatroskaParser"]);
  assert.deepEqual(await supporters("application/x-parquet"), ["ColumnarParser"]);
  assert.deepEqual(await supporters("image/vnd.dxf"), ["DXFParser"]);
});

test("registration order picks the intended parser for overlapping types", async () => {
  assert.equal((await supporters("audio/mp4"))[0], "MP4Parser");
  assert.equal((await supporters("audio/x-ms-wma"))[0], "AudioParser");
  assert.equal((await supporters("application/rdf+xml"))[0], "XMLParser");
});
