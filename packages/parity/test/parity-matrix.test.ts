import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MediaType, ParseContext } from "../../core/src/index.ts";
import { createDefaultParser } from "../../parsers/src/index.ts";
import { buildMatrix, loadDeclared, renderMarkdown } from "../../../scripts/parity-matrix.ts";

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

test("every Tika 4.2.0 parser type is implemented or carries a declared decision", async () => {
  const { problems } = await buildMatrix();
  assert.deepEqual(problems, [], "run node scripts/parity-matrix.ts and declare or implement each item");
});

test("docs/parity-matrix.{json,md} match the generator", async () => {
  const declared = loadDeclared();
  const { matrix } = await buildMatrix(declared);
  assert.equal(read("docs/parity-matrix.json"), `${JSON.stringify(matrix, null, 1)}\n`);
  assert.equal(read("docs/parity-matrix.md"), renderMarkdown(matrix, declared));
});

test("an accepted fallback really reaches the parser Tika uses", async () => {
  const parser = createDefaultParser();
  const cases: ReadonlyArray<[string, string]> = [
    ["application/vnd.ms-excel.sheet.macroenabled.12", "OoxmlParser"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.template", "OoxmlParser"],
    ["video/x-m4v", "Mp4Parser"],
  ];
  for (const [type, expected] of cases) {
    const [first] = await parser.selectParsers(MediaType.parseOrThrow(type), new ParseContext());
    assert.equal(first?.kind, "supertype", `${type} should match through a supertype`);
    assert.equal(first?.parser.constructor.name, expected, type);
  }
});
