import assert from "node:assert/strict";
import { test } from "node:test";
import {
  METADATA_KEYS,
  METADATA_NAMESPACES,
  METADATA_SCHEMA_STATS,
  Metadata,
  isKnownMetadataKey,
  isOpenMetadataNamespaceKey,
  metadataKeyDefinition,
  metadataKeyNamespace,
} from "../src/index.ts";

test("metadata schema exposes upstream keys and types", () => {
  assert.equal(METADATA_KEYS.length, METADATA_SCHEMA_STATS.keys);
  assert.ok(METADATA_KEYS.length > 700);
  const title = metadataKeyDefinition("dc:title");
  assert.equal(title?.valueType, "TEXT");
  assert.equal(title?.namespace, "dc");
  assert.equal(metadataKeyDefinition("dc:TITLE"), undefined);
  assert.equal(isKnownMetadataKey("dc:creator"), true);
  assert.equal(metadataKeyNamespace("dc:title"), "dc");
  assert.equal(metadataKeyNamespace("plain"), "");
});

test("open namespaces accept unenumerated keys", () => {
  assert.ok(METADATA_NAMESPACES.length > 0);
  assert.equal(isOpenMetadataNamespaceKey("custom:anything"), true);
  assert.equal(isOpenMetadataNamespaceKey("dc:title"), false);
});

test("metadata keeps unknown keys verbatim", () => {
  const metadata = new Metadata();
  metadata.set("Totally:Unknown", "value");
  assert.equal(metadata.get("Totally:Unknown"), "value");
  assert.equal(isKnownMetadataKey("Totally:Unknown"), false);
});
