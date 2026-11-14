import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTags, xmpElementBlock, xmpListItems } from "../src/xmp-elements.ts";

test("xmpElementBlock reads the first element with a closer, whatever attributes the opener has", () => {
  assert.equal(xmpElementBlock('<a><dc:title xml:lang="x">T</dc:title><dc:title>U</dc:title>', "dc:title"), "T");
  assert.equal(xmpElementBlock("<dc:title/>x</dc:title>", "dc:title"), "x");
});

test("xmpElementBlock does not take a longer element name for the one asked for", () => {
  assert.equal(xmpElementBlock("<dc:titles>A</dc:titles><dc:title>B</dc:title>", "dc:title"), "B");
  assert.equal(xmpElementBlock("<dc:title", "dc:title"), undefined);
});

test("xmpElementBlock returns undefined without a closer", () => {
  assert.equal(xmpElementBlock("<dc:title>open", "dc:title"), undefined);
});

test("xmpListItems reads each rdf:li and skips an unclosed one", () => {
  assert.deepEqual(xmpListItems('<rdf:Alt><rdf:li xml:lang="x-default">One</rdf:li><rdf:li>Two</rdf:li><rdf:li>open'), ["One", "Two"]);
  assert.deepEqual(xmpListItems("<rdf:list>x</rdf:list>"), []);
});

test("stripTags removes <...> runs and leaves a lone < or <> alone", () => {
  assert.equal(stripTags("a<b>c</b>d"), "acd");
  assert.equal(stripTags("a < b"), "a < b");
  assert.equal(stripTags("a<>b"), "a<>b");
  assert.equal(stripTags("<<a>b"), "b");
});

test("many unclosed openers are read in linear time (tikajs-f2pv)", () => {
  const started = performance.now();
  const openers = 60_000;
  assert.equal(xmpElementBlock("<dc:title>".repeat(openers), "dc:title"), undefined);
  assert.deepEqual(xmpListItems("<rdf:li>".repeat(openers)), []);
  assert.equal(stripTags("<".repeat(openers * 10)).length, openers * 10);
  assert.ok(performance.now() - started < 3000, "took too long");
});
