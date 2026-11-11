import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType, ParseContext } from "@spikedpunch/ripstream-core";
import { createDefaultParser } from "../src/index.ts";

/* The SAS7BDAT parser as the default parser list sees it (tikajs-68os.21); split from sas7bdat.test.ts, see tsd-facade.test.ts. */

test("the SAS7BDAT parser is the exact match for application/x-sas-data", async () => {
  const matches = await createDefaultParser().selectParsers(MediaType.parseOrThrow("application/x-sas-data"), new ParseContext());
  assert.deepEqual(
    matches.slice(0, 1).map((match) => ({ name: match.parser.name, kind: match.kind })),
    [{ name: "SAS7BDATParser", kind: "exact" }],
  );
});
