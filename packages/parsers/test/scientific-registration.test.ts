import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType, ParseContext } from "@spikedpunch/ripstream-core";
import { createDefaultParser } from "../src/index.ts";

/* Registration of the ENVI, ISA-Tab and ISO 19139 parsers. Kept apart from their unit tests, which load only their own source. */

const select = (type: string) => createDefaultParser().selectParsers(MediaType.parseOrThrow(type), new ParseContext());

test("the default registry sends application/envi.hdr to EnviHeaderParser exactly", async () => {
  const [first] = await select("application/envi.hdr");
  assert.deepEqual({ name: first?.parser.name, kind: first?.kind }, { name: "EnviHeaderParser", kind: "exact" });
});

test("the default registry sends application/x-isatab to ISArchiveParser exactly", async () => {
  const [first] = await select("application/x-isatab");
  assert.deepEqual({ name: first?.parser.name, kind: first?.kind }, { name: "ISArchiveParser", kind: "exact" });
});

test("the default registry sends text/iso19139+xml to GeographicInformationParser before XmlParser", async () => {
  const selected = await select("text/iso19139+xml");
  assert.deepEqual(
    selected.slice(0, 2).map(({ parser, kind }) => ({ name: parser.name, kind })),
    [{ name: "GeographicInformationParser", kind: "exact" }, { name: "XMLParser", kind: "supertype" }],
  );
});
