import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CompositeParser,
  MediaType,
  MediaTypeRegistry,
  MimeFilteringDecorator,
  ParseContext,
  ParseContextKey,
  type Parser,
} from "../src/index.ts";

const type = (value: string): MediaType => MediaType.parseOrThrow(value);
const noop = async (): Promise<void> => {};

/** A parser with a fixed set of types, counting how often it is asked for them. */
function counting(name: string, types: readonly string[]): Parser & { asked: number } {
  const parser = {
    name,
    asked: 0,
    getSupportedTypes: () => {
      parser.asked++;
      return new Set(types.map(type));
    },
    parse: noop,
  };
  return parser;
}

const names = async (parser: CompositeParser, value: string, ctx = new ParseContext()): Promise<string[]> =>
  (await parser.selectParsers(type(value), ctx)).map((match) => match.parser.name);

test("a type that was ranked once is not ranked again: parsers are not asked for their types a second time", async () => {
  const a = counting("a", ["text/plain"]);
  const b = counting("b", ["application/pdf"]);
  const composite = new CompositeParser({ parsers: [a, b] });
  assert.deepEqual(await names(composite, "text/plain"), ["a"]);
  assert.deepEqual(await names(composite, "text/plain"), ["a"]);
  assert.deepEqual([a.asked, b.asked], [1, 1]);
});

test("each content type has its own list, and a type with parameters is not the bare type", async () => {
  const dgn8 = counting("dgn8", ["image/vnd.dgn; version=8"]);
  const dgn = counting("dgn", ["image/vnd.dgn"]);
  const composite = new CompositeParser({ parsers: [dgn8, dgn] });
  assert.deepEqual(await names(composite, "image/vnd.dgn; version=8"), ["dgn8", "dgn"]);
  assert.deepEqual(await names(composite, "image/vnd.dgn; version=7"), ["dgn"]);
  assert.deepEqual(await names(composite, "image/vnd.dgn"), ["dgn"]);
  assert.deepEqual(await names(composite, "image/vnd.dgn; version=8"), ["dgn8", "dgn"]);
});

test("addParser drops the lists: the new parser is a candidate on the next call", async () => {
  const wild = counting("wild", ["*/*"]);
  const composite = new CompositeParser({ parsers: [wild] });
  assert.deepEqual(await names(composite, "text/plain"), ["wild"]);
  composite.addParser(counting("exact", ["text/plain"]));
  assert.deepEqual(await names(composite, "text/plain"), ["exact", "wild"]);
});

test("a parser added to a composite inside another drops the outer one's lists", async () => {
  const inner = new CompositeParser({ parsers: [counting("a", ["text/plain"])] });
  const outer = new CompositeParser({ parsers: [inner] });
  assert.deepEqual(await names(outer, "application/pdf"), []);
  inner.addParser(counting("pdf", ["application/pdf"]));
  assert.deepEqual(await names(outer, "application/pdf"), ["CompositeParser"]);
});

test("a type, alias or supertype added to the registry drops the lists", async () => {
  const registry = new MediaTypeRegistry();
  const composite = new CompositeParser({ registry, parsers: [counting("base", ["application/x-base"])] });
  assert.deepEqual(await names(composite, "application/x-child"), []);
  registry.addSuperType(type("application/x-child"), type("application/x-base"));
  assert.deepEqual(await names(composite, "application/x-child"), ["base"]);

  assert.deepEqual(await names(composite, "application/x-alias"), []);
  registry.addType(type("application/x-base"));
  registry.addAlias(type("application/x-base"), type("application/x-alias"));
  assert.deepEqual(await names(composite, "application/x-alias"), ["base"]);
});

test("two composites over the same parsers and registry, narrowed differently, do not share lists", async () => {
  const shared = counting("shared", ["text/plain", "application/pdf"]);
  const registry = new MediaTypeRegistry();
  const textOnly = new CompositeParser({ registry, parsers: [new MimeFilteringDecorator(shared, [type("text/plain")])] });
  const pdfOnly = new CompositeParser({ registry, parsers: [new MimeFilteringDecorator(shared, [type("application/pdf")])] });
  const plain = new CompositeParser({ registry, parsers: [shared] });
  assert.deepEqual(await names(textOnly, "text/plain"), ["Decorated(shared)"]);
  assert.deepEqual(await names(pdfOnly, "text/plain"), []);
  assert.deepEqual(await names(plain, "text/plain"), ["shared"]);
  assert.deepEqual(await names(textOnly, "application/pdf"), []);
  assert.deepEqual(await names(pdfOnly, "application/pdf"), ["Decorated(shared)"]);
});

test("a parser whose types come from the context is asked with each call's context", async () => {
  const key = new ParseContextKey<string>("test.claimed-type");
  const parser: Parser = {
    name: "by-context",
    getSupportedTypes: (ctx) => new Set([type(ctx.get(key) ?? "text/plain")]),
    parse: noop,
  };
  const composite = new CompositeParser({ parsers: [parser, counting("static", ["application/pdf"])] });
  const withPdf = new ParseContext();
  withPdf.set(key, "application/pdf");
  const withCsv = new ParseContext();
  withCsv.set(key, "text/csv");

  assert.deepEqual(await names(composite, "application/pdf", withPdf), ["by-context", "static"]);
  assert.deepEqual(await names(composite, "application/pdf", withCsv), ["static"]);
  assert.deepEqual(await names(composite, "text/csv", withCsv), ["by-context"]);
  assert.deepEqual(await names(composite, "application/pdf", withPdf), ["by-context", "static"]);
  // The default, with nothing set.
  assert.deepEqual(await names(composite, "text/plain"), ["by-context"]);
});

test("a parser that hands the context to another is context sensitive too", async () => {
  const key = new ParseContextKey<boolean>("test.on");
  const inner: Parser = {
    name: "inner",
    getSupportedTypes: (ctx) => new Set(ctx.get(key) === true ? [type("text/plain")] : []),
    parse: noop,
  };
  const composite = new CompositeParser({ parsers: [new MimeFilteringDecorator(inner, [type("text/plain")])] });
  const on = new ParseContext();
  on.set(key, true);
  assert.deepEqual(await names(composite, "text/plain", on), ["Decorated(inner)"]);
  assert.deepEqual(await names(composite, "text/plain", new ParseContext()), []);
  assert.deepEqual(await names(composite, "text/plain", on), ["Decorated(inner)"]);
});

test("the lists are bounded: many distinct types stay correct and the oldest is ranked again", async () => {
  const parser = counting("p", ["text/*"]);
  const composite = new CompositeParser({ parsers: [parser] });
  for (let index = 0; index < 600; index++) {
    assert.deepEqual(await names(composite, `text/x-${index}`), ["p"]);
  }
  assert.equal(parser.asked, 600);
  await names(composite, "text/x-599");
  assert.equal(parser.asked, 600, "a recent type is kept");
  await names(composite, "text/x-0");
  assert.equal(parser.asked, 601, "the oldest was evicted");
});

test("a kept list cannot be changed by a caller", async () => {
  const composite = new CompositeParser({ parsers: [counting("a", ["text/plain"])] });
  const first = await composite.selectParsers(type("text/plain"), new ParseContext());
  assert.throws(() => (first as unknown as unknown[]).push({}), TypeError);
  assert.deepEqual((await composite.selectParsers(type("text/plain"), new ParseContext())).length, 1);
});
