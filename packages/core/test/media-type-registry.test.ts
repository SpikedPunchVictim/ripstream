import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType } from "../src/media-type.ts";
import { MediaTypeRegistry } from "../src/media-type-registry.ts";

function type(value: string): MediaType {
  const parsed = MediaType.parse(value);
  assert.ok(parsed, value);
  return parsed;
}

test("walks the upstream supertype order", () => {
  const registry = new MediaTypeRegistry();
  assert.equal(registry.getSupertype(type("text/csv"))?.toString(), "text/plain");
  assert.equal(
    registry.getSupertype(type("application/foo+xml"))?.toString(),
    "application/xml",
  );
  assert.equal(
    registry.getSupertype(type("application/foo+zip"))?.toString(),
    "application/zip",
  );
  assert.equal(
    registry.getSupertype(type("image/png"))?.toString(),
    "application/octet-stream",
  );
  assert.equal(registry.getSupertype(MediaType.OCTET_STREAM), null);
});

test("parameters map to base type before defaults", () => {
  const registry = new MediaTypeRegistry();
  assert.equal(
    registry.getSupertype(type("text/plain; charset=UTF-8"))?.toString(),
    "text/plain",
  );
});

test("explicit inheritance wins", () => {
  const registry = new MediaTypeRegistry();
  registry.addSuperType(type("application/x-custom"), type("application/pdf"));
  assert.equal(
    registry.getSupertype(type("application/x-custom"))?.toString(),
    "application/pdf",
  );
  assert.equal(
    registry.isSpecializationOf(type("application/x-custom"), type("application/pdf")),
    true,
  );
});

test("specialization walks transitively", () => {
  const registry = new MediaTypeRegistry();
  assert.equal(
    registry.isSpecializationOf(type("text/csv"), MediaType.OCTET_STREAM),
    true,
  );
  assert.equal(
    registry.isSpecializationOf(MediaType.TEXT_PLAIN, type("text/csv")),
    false,
  );
  assert.equal(registry.isInstanceOf(MediaType.TEXT_PLAIN, MediaType.TEXT_PLAIN), true);
  assert.equal(registry.isInstanceOf(null, MediaType.TEXT_PLAIN), false);
});

test("normalizes aliases and preserves parameters", () => {
  const registry = new MediaTypeRegistry();
  registry.addType(MediaType.TEXT_PLAIN);
  registry.addAlias(MediaType.TEXT_PLAIN, type("text/x-plain"));

  const normalized = registry.normalize(type("text/x-plain; charset=UTF-8"));
  assert.ok(normalized);
  assert.equal(normalized.toString(), "text/plain; charset=UTF-8");
});

test("normalization leaves unregistered types untouched", () => {
  const registry = new MediaTypeRegistry();
  const custom = type("application/x-custom; a=1");
  assert.equal(registry.normalize(custom), custom);
  assert.equal(registry.normalize(null), null);
});

test("handles cyclic inheritance without hanging", () => {
  const registry = new MediaTypeRegistry();
  registry.addSuperType(type("application/a"), type("application/b"));
  registry.addSuperType(type("application/b"), type("application/a"));
  assert.equal(
    registry.isSpecializationOf(type("application/a"), type("application/never")),
    false,
  );
});
