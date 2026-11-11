import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MediaType, ParseContext } from "@spikedpunch/ripstream-core";
import { createDefaultParser, createRipstream } from "../src/index.ts";

/*
 * Registration of the Unix dump reader of tikajs-68os.47: PackageParser claims application/x-tika-unix-dump in Tika
 * 4.2.0 (generated/tika-parser-types.ts holds the claim). Read from the Tika source, not run against a Tika.
 */

test("application/x-tika-unix-dump reaches UnixDumpParser exactly", async () => {
  const matches = await createDefaultParser().selectParsers(
    MediaType.parseOrThrow("application/x-tika-unix-dump"),
    new ParseContext(),
  );
  assert.deepEqual(
    matches.map((match) => [match.parser.name, match.kind]),
    [["UnixDumpParser", "exact"]],
  );
});

test("a dump volume is embedded documents in a recursive parse, named by their path", async () => {
  const bytes = readFileSync(
    fileURLToPath(new URL("./fixtures/archive-samples/synthetic-unix-dump.dump", import.meta.url)),
  );
  const records = await createRipstream().parseRecursive(bytes, { filename: "volume.dump" });
  assert.deepEqual(
    records.map((record) => record.metadata.get("tk:resource-name")),
    ["volume.dump", "readme.txt", "docs/notes.txt"],
  );
  assert.equal(records[0]?.metadata.get("Content-Type"), "application/x-tika-unix-dump");
  assert.equal(records[2]?.metadata.get("fs:modified"), "2020-09-13T12:26:40Z");
  assert.match(records[2]?.content ?? "", /Notes kept in a subdirectory/);
});
