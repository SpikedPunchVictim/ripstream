import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  CompositeParser,
  CONTEXT_KEYS,
  MediaType,
  MediaTypeRegistry,
  Metadata,
  ParseContext,
  ParserDeclinedError,
  RipstreamInputStream,
  UnsupportedFormatError,
  type Parser,
} from "../src/index.ts";

const type = (value: string): MediaType => MediaType.parseOrThrow(value);

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLSM = "application/vnd.ms-excel.sheet.macroenabled.12";

/** xlsm is a subtype of xlsx; application/x-alias is an alias of the xlsx type. */
function registry(): MediaTypeRegistry {
  const r = new MediaTypeRegistry();
  r.addType(type(XLSX));
  r.addType(type(XLSM));
  r.addSuperType(type(XLSM), type(XLSX));
  r.addAlias(type(XLSX), type("application/x-alias-xlsx"));
  return r;
}

function named(name: string, types: readonly string[], onParse?: () => void): Parser {
  return {
    name,
    getSupportedTypes: () => new Set(types.map(type)),
    async parse(stream) {
      onParse?.();
      for await (const _chunk of stream) {
        // consume
      }
    },
  };
}

async function run(parser: CompositeParser, contentType: string): Promise<void> {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.CONTENT_TYPE, type(contentType));
  const stream = await RipstreamInputStream.from(new TextEncoder().encode("abc"));
  await parser.parse(stream, new BodyContentHandler(), new Metadata(), context);
}

test("a subtype with no parser of its own is handled by its supertype's parser", async () => {
  const calls: string[] = [];
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [named("ooxml", [XLSX], () => calls.push("ooxml"))],
  });
  await run(parser, XLSM);
  assert.deepEqual(calls, ["ooxml"]);
});

test("without a registry only exact and wildcard matches apply", async () => {
  const parser = new CompositeParser({ parsers: [named("ooxml", [XLSX])] });
  await assert.rejects(run(parser, XLSM), UnsupportedFormatError);
});

test("an exact registration beats the supertype's parser", async () => {
  const calls: string[] = [];
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [
      named("super", [XLSX], () => calls.push("super")),
      named("exact", [XLSM], () => calls.push("exact")),
    ],
  });
  await run(parser, XLSM);
  assert.deepEqual(calls, ["exact"]);
});

test("a supertype's parser beats a type wildcard", async () => {
  const calls: string[] = [];
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [
      named("wild", ["application/*"], () => calls.push("wild")),
      named("super", [XLSX], () => calls.push("super")),
    ],
  });
  await run(parser, XLSM);
  assert.deepEqual(calls, ["super"]);
});

test("an alias content type reaches the parser registered for the canonical type", async () => {
  const calls: string[] = [];
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [named("ooxml", [XLSX], () => calls.push("ooxml"))],
  });
  await run(parser, "application/x-alias-xlsx");
  assert.deepEqual(calls, ["ooxml"]);
});

test("a parser registered under an alias is found by the canonical type", async () => {
  const calls: string[] = [];
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [named("aliased", ["application/x-alias-xlsx"], () => calls.push("aliased"))],
  });
  await run(parser, XLSX);
  assert.deepEqual(calls, ["aliased"]);
});

test("a decline by the exact parser falls through to the supertype's parser", async () => {
  const calls: string[] = [];
  const declining: Parser = {
    name: "exact",
    getSupportedTypes: () => new Set([type(XLSM)]),
    async parse() {
      calls.push("exact");
      throw new ParserDeclinedError("not mine");
    },
  };
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [declining, named("super", [XLSX], () => calls.push("super"))],
  });
  await run(parser, XLSM);
  assert.deepEqual(calls, ["exact", "super"]);
});

test("selectParsers reports how each candidate matched, best first", async () => {
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [
      named("wild", ["*/*"]),
      named("super", [XLSX]),
      named("exact", [XLSM]),
      named("other", ["text/plain"]),
    ],
  });
  const matches = await parser.selectParsers(type(XLSM), new ParseContext());
  assert.deepEqual(
    matches.map((m) => [m.parser.name, m.kind, m.via?.toString() ?? null]),
    [
      ["exact", "exact", XLSM],
      ["super", "supertype", XLSX],
      ["wild", "wildcard", null],
    ],
  );
});

test("a content type with parameters matches on its base type", async () => {
  const calls: string[] = [];
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [named("ooxml", [XLSX], () => calls.push("ooxml"))],
  });
  await run(parser, `${XLSM}; charset=utf-8`);
  assert.deepEqual(calls, ["ooxml"]);
});

test("a type wildcard beats a catch-all parser registered for the root type", async () => {
  const calls: string[] = [];
  const parser = new CompositeParser({
    registry: registry(),
    parsers: [
      named("catch-all", ["application/octet-stream"], () => calls.push("catch-all")),
      named("wild", ["application/*"], () => calls.push("wild")),
    ],
  });
  await run(parser, XLSM);
  assert.deepEqual(calls, ["wild"]);
});

test("a type with parameters follows its own supertype entry, not its base type's", async () => {
  const calls: string[] = [];
  const reg = new MediaTypeRegistry();
  reg.addType(type("image/vnd.dgn"));
  reg.addType(type("image/vnd.dgn; version=8"));
  reg.addType(type("application/x-tika-msoffice"));
  reg.addSuperType(type("image/vnd.dgn; version=8"), type("application/x-tika-msoffice"));
  const parser = new CompositeParser({
    registry: reg,
    parsers: [named("ole2", ["application/x-tika-msoffice"], () => calls.push("ole2"))],
  });
  await run(parser, "image/vnd.dgn; version=8");
  assert.deepEqual(calls, ["ole2"]);
  await assert.rejects(run(parser, "image/vnd.dgn"), UnsupportedFormatError);
});

test("tk:parsed-by names the parser that handled the document, not one that declined it", async () => {
  const declining: Parser = {
    name: "declines",
    getSupportedTypes: () => new Set([type(XLSX)]),
    async parse() {
      throw new ParserDeclinedError("not mine");
    },
  };
  const parser = new CompositeParser({ parsers: [declining, named("takes", [XLSX])] });
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.CONTENT_TYPE, type(XLSX));
  const metadata = new Metadata();
  await parser.parse(await RipstreamInputStream.from(new TextEncoder().encode("abc")), new BodyContentHandler(), metadata, context);
  assert.deepEqual(metadata.getAll("tk:parsed-by"), ["takes"]);
});

test("a parameterised claim outranks the bare type and is not offered another version", async () => {
  const calls: string[] = [];
  const r = new MediaTypeRegistry();
  r.addType(type("image/vnd.dgn"));
  const parser = new CompositeParser({
    registry: r,
    parsers: [
      named("v8", ["image/vnd.dgn; version=8"], () => calls.push("v8")),
      named("bare", ["image/vnd.dgn"], () => calls.push("bare")),
    ],
  });
  await run(parser, "image/vnd.dgn; version=8");
  assert.deepEqual(calls, ["v8"]);
  calls.length = 0;
  await run(parser, "image/vnd.dgn; version=7");
  assert.deepEqual(calls, ["bare"]);
});
