import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType } from "../src/media-type.ts";

test("parses and caches simple lowercase types", () => {
  const first = MediaType.parse("text/plain");
  const second = MediaType.parse("text/plain");
  assert.ok(first);
  assert.equal(first, second);
  assert.equal(first.type, "text");
  assert.equal(first.subtype, "plain");
  assert.equal(first.toString(), "text/plain");
  assert.equal(first.hasParameters, false);
});

test("normalizes type, subtype, and parameter keys, preserving values", () => {
  const type = MediaType.parse("  TEXT / PLAIN ; Charset=UTF-8 ; A=B  ");
  assert.ok(type);
  assert.equal(type.toString(), "text/plain; a=B; charset=UTF-8");
  assert.deepEqual([...type.parameters], [
    ["a", "B"],
    ["charset", "UTF-8"],
  ]);
});

test("sorts parameters by lowercase key", () => {
  const type = MediaType.parse("text/plain; z=1; A=2; m=3");
  assert.ok(type);
  assert.equal(type.toString(), "text/plain; a=2; m=3; z=1");
});

test("quotes values containing separators or whitespace", () => {
  const spaced = new MediaType("text", "plain", { note: "a b" });
  assert.equal(spaced.toString(), 'text/plain; note="a b"');

  const quoted = new MediaType("text", "plain", { note: 'a"b' });
  assert.equal(quoted.toString(), 'text/plain; note="a\\"b"');
});

test("unquotes parameter values on parse", () => {
  const type = MediaType.parse('text/plain; note="a b"; other=\'c\'');
  assert.ok(type);
  assert.equal(type.getParameter("note"), "a b");
  assert.equal(type.getParameter("other"), "c");
});

test("supports charset-first syntax", () => {
  const type = MediaType.parse("charset=UTF-8; text/html");
  assert.ok(type);
  assert.equal(type.toString(), "text/html; charset=UTF-8");
});

test("returns null for malformed input", () => {
  assert.equal(MediaType.parse(null), null);
  assert.equal(MediaType.parse(undefined), null);
  assert.equal(MediaType.parse(""), null);
  assert.equal(MediaType.parse("text"), null);
  assert.equal(MediaType.parse("text/plain/extra"), null);
});

test("base type drops parameters and equality is canonical-string equality", () => {
  const first = MediaType.parse("text/plain; charset=UTF-8; a=1");
  const second = MediaType.parse("text/plain; a=1; charset=UTF-8");
  assert.ok(first && second);
  assert.equal(first.equals(second), true);
  assert.equal(first.getBaseType().toString(), "text/plain");
  assert.equal(first.getBaseType(), MediaType.TEXT_PLAIN);
});

test("withParameters unions and overrides; withoutParameters removes", () => {
  const base = MediaType.parse("text/plain; a=1");
  assert.ok(base);
  assert.equal(
    base.withParameters({ a: "2", b: "3" }).toString(),
    "text/plain; a=2; b=3",
  );
  assert.equal(base.withoutParameters("a").toString(), "text/plain");
});

test("exposes charset convenience getter", () => {
  const type = MediaType.parse("text/plain; charset=UTF-8");
  assert.ok(type);
  assert.equal(type.charset, "UTF-8");
});
