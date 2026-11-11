import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CompositeMetadataFilter,
  ExcludeFieldMetadataFilter,
  IncludeFieldMetadataFilter,
  Metadata,
  MetadataWriteLimitFilter,
  NoOpFilter,
  ParseContext,
  type MetadataFilter,
} from "../src/index.ts";

function metadataOf(values: Record<string, string | string[]>): Metadata {
  const metadata = new Metadata();
  for (const [name, value] of Object.entries(values)) {
    for (const each of Array.isArray(value) ? value : [value]) metadata.add(name, each);
  }
  return metadata;
}

function namesOf(metadata: Metadata): string[] {
  return metadata.names().sort();
}

test("a filter is given the whole list and may change its length", () => {
  const dropSecond: MetadataFilter = {
    filter(list) {
      list.splice(1, 1);
    },
  };
  const list = [metadataOf({ a: "1" }), metadataOf({ b: "2" }), metadataOf({ c: "3" })];
  dropSecond.filter(list, new ParseContext());
  assert.deepEqual(list.map(namesOf), [["a"], ["c"]]);
});

test("a composite runs its filters in order, each seeing what the one before produced", () => {
  const seen: string[][] = [];
  const spy: MetadataFilter = {
    filter(list) {
      seen.push(namesOf(list[0]!));
    },
  };
  const chain = new CompositeMetadataFilter([
    spy,
    new ExcludeFieldMetadataFilter({ exclude: ["b"] }),
    spy,
    new IncludeFieldMetadataFilter({ include: ["a"] }),
    spy,
  ]);
  chain.filter([metadataOf({ a: "1", b: "2", c: "3" })], new ParseContext());
  assert.deepEqual(seen, [["a", "b", "c"], ["a", "c"], ["a"]]);
});

test("a composite of no filters changes nothing", () => {
  const list = [metadataOf({ a: "1" }), metadataOf({ b: "2" })];
  new CompositeMetadataFilter([]).filter(list, new ParseContext());
  assert.deepEqual(list.map(namesOf), [["a"], ["b"]]);
});

test("a composite hands every filter the same context", () => {
  const context = new ParseContext();
  const contexts: ParseContext[] = [];
  const spy: MetadataFilter = {
    filter(_list, given) {
      contexts.push(given);
    },
  };
  new CompositeMetadataFilter([spy, spy]).filter([], context);
  assert.deepEqual(contexts, [context, context]);
});

test("a composite is not changed by a later change to the array it was built from", () => {
  const filters: MetadataFilter[] = [new NoOpFilter()];
  const chain = new CompositeMetadataFilter(filters);
  filters.push(new NoOpFilter());
  assert.equal(chain.filters.length, 1);
});

test("a composite exposes the filters it was built with, in order", () => {
  const first = new NoOpFilter();
  const second = new NoOpFilter();
  assert.deepEqual(new CompositeMetadataFilter([first, second]).filters, [first, second]);
});

test("the no-op filter leaves every document as it was", () => {
  const list = [metadataOf({ a: ["1", "2"], b: "3" })];
  new NoOpFilter().filter(list, new ParseContext());
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]!.getAll("a"), ["1", "2"]);
  assert.equal(list[0]!.get("b"), "3");
});

test("include keeps the names it is given and drops the rest, in every document of the list", () => {
  const list = [metadataOf({ a: "1", b: "2" }), metadataOf({ b: "3", c: "4" })];
  new IncludeFieldMetadataFilter({ include: ["b"] }).filter(list, new ParseContext());
  assert.deepEqual(list.map(namesOf), [["b"], ["b"]]);
});

test("include matches a name exactly, so 'author' keeps 'author' and drops 'Author'", () => {
  const list = [metadataOf({ Author: "A", author: "a", "dc:author": "d" })];
  new IncludeFieldMetadataFilter({ include: ["author"] }).filter(list, new ParseContext());
  assert.deepEqual(namesOf(list[0]!), ["author"]);
});

test("include with an upper-case name keeps that name and drops its lower-case spelling", () => {
  const list = [metadataOf({ Author: "A", author: "a" })];
  new IncludeFieldMetadataFilter({ include: ["Author"] }).filter(list, new ParseContext());
  assert.deepEqual(namesOf(list[0]!), ["Author"]);
});

test("include treats a pattern character as part of the name, not a glob", () => {
  const list = [metadataOf({ "dc:title": "t", "dc:creator": "c", "dc:*": "star" })];
  new IncludeFieldMetadataFilter({ include: ["dc:*"] }).filter(list, new ParseContext());
  assert.deepEqual(namesOf(list[0]!), ["dc:*"]);
});

test("include keeps every value of a name it keeps", () => {
  const list = [metadataOf({ "dc:subject": ["x", "y"], other: "z" })];
  new IncludeFieldMetadataFilter({ include: ["dc:subject"] }).filter(list, new ParseContext());
  assert.deepEqual(list[0]!.getAll("dc:subject"), ["x", "y"]);
});

test("include with no names empties every document, as Tika's does", () => {
  const list = [metadataOf({ a: "1" }), metadataOf({ b: "2" })];
  new IncludeFieldMetadataFilter({ include: [] }).filter(list, new ParseContext());
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(namesOf), [[], []]);
});

test("include with a name no document has leaves nothing, and does not fail", () => {
  const list = [metadataOf({ a: "1" })];
  new IncludeFieldMetadataFilter({ include: ["absent"] }).filter(list, new ParseContext());
  assert.deepEqual(namesOf(list[0]!), []);
});

test("exclude drops the names it is given and keeps the rest, in every document of the list", () => {
  const list = [metadataOf({ a: "1", b: "2" }), metadataOf({ b: "3", c: "4" })];
  new ExcludeFieldMetadataFilter({ exclude: ["b"] }).filter(list, new ParseContext());
  assert.deepEqual(list.map(namesOf), [["a"], ["c"]]);
});

test("exclude matches a name exactly, so 'Author' drops 'Author' and keeps 'author'", () => {
  const list = [metadataOf({ Author: "A", author: "a" })];
  new ExcludeFieldMetadataFilter({ exclude: ["Author"] }).filter(list, new ParseContext());
  assert.deepEqual(namesOf(list[0]!), ["author"]);
});

test("exclude treats a pattern character as part of the name, not a glob", () => {
  const list = [metadataOf({ "pdf:producer": "p", "pdf:*": "star" })];
  new ExcludeFieldMetadataFilter({ exclude: ["pdf:*"] }).filter(list, new ParseContext());
  assert.deepEqual(namesOf(list[0]!), ["pdf:producer"]);
});

test("exclude with no names, or a name no document has, changes nothing", () => {
  const list = [metadataOf({ a: "1" })];
  new ExcludeFieldMetadataFilter({ exclude: [] }).filter(list, new ParseContext());
  new ExcludeFieldMetadataFilter({ exclude: ["absent"] }).filter(list, new ParseContext());
  assert.deepEqual(namesOf(list[0]!), ["a"]);
});

test("include and exclude copy the names they are given", () => {
  const include = ["a"];
  const exclude = ["b"];
  const includer = new IncludeFieldMetadataFilter({ include });
  const excluder = new ExcludeFieldMetadataFilter({ exclude });
  include.push("b");
  exclude.push("a");
  const list = [metadataOf({ a: "1", b: "2" })];
  includer.filter(list, new ParseContext());
  assert.deepEqual(namesOf(list[0]!), ["a"]);
  const other = [metadataOf({ a: "1", b: "2" })];
  excluder.filter(other, new ParseContext());
  assert.deepEqual(namesOf(other[0]!), ["a"]);
});

test("the write limit caps the values of every document in the list", () => {
  const list = [
    metadataOf({ "dc:subject": ["one", "two"], "dc:title": "abcdefgh" }),
    metadataOf({ "dc:title": "ijklmnop" }),
  ];
  new MetadataWriteLimitFilter({ maxValues: 1, maxValueChars: 3 }).filter(list, new ParseContext());
  assert.deepEqual(list[0]!.getAll("dc:subject"), ["one"]);
  assert.equal(list[0]!.get("dc:title"), "abc");
  assert.equal(list[1]!.get("dc:title"), "ijk");
});
