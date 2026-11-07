import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstream } from "../src/index.ts";

const encoder = new TextEncoder();
const ripstream = createRipstream();

test("parses comma CSV", async () => {
  const result = await ripstream.parse(encoder.encode("name,age\nAda,36\nGrace,85\n"), {
    filename: "people.csv",
  });
  assert.equal(result.metadata.get("Content-Type"), "text/csv");
  assert.match(result.text, /Ada/);
  assert.match(result.text, /Grace/);
  assert.equal(result.text.match(/\t/g)?.length, 6);
});

test("handles quoted delimiters and doubled quotes", async () => {
  const result = await ripstream.parse(
    encoder.encode('a,"b,c","say ""hi"""\nx,y,z\n'),
    { filename: "quoted.csv" },
  );
  assert.match(result.text, /b,c/);
  assert.match(result.text, /say "hi"/);
});

test("detects semicolon and tab delimiters", async () => {
  const semicolon = await ripstream.parse(encoder.encode("a;b\n1;2\n"), {
    filename: "semi.csv",
  });
  assert.match(semicolon.text, /a/);
  assert.match(semicolon.text, /b/);

  const tab = await ripstream.parse(encoder.encode("a\tb\n1\t2\n"), {
    filename: "tab.tsv",
  });
  assert.match(tab.text, /a/);
});

test("preserves newlines inside quoted fields", async () => {
  const result = await ripstream.parse(encoder.encode('a,"line1\nline2"\n'), {
    filename: "multi.csv",
  });
  assert.match(result.text, /line1\nline2/);
});
