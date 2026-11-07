import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TIKA_MIME_REGISTRY,
  TIKA_MIMETYPES_SHA256,
  TIKA_MIMETYPES_SOURCE,
} from "../src/index.ts";

function entry(type: string) {
  const found = TIKA_MIME_REGISTRY.find((candidate) => candidate.type === type);
  assert.ok(found, `missing ${type}`);
  return found;
}

test("registry contains the full upstream type set", () => {
  assert.equal(TIKA_MIME_REGISTRY.length, 1701);
  assert.equal(TIKA_MIMETYPES_SHA256.length, 64);
  assert.match(TIKA_MIMETYPES_SOURCE, /tika-mimetypes\.xml$/);
});

test("core document types are registered with globs", () => {
  assert.deepEqual(entry("application/pdf").globs, ["*.pdf"]);
  assert.ok(entry("application/vnd.openxmlformats-officedocument.wordprocessingml.document").globs.includes("*.docx"));
  assert.ok(entry("application/epub+zip").globs.includes("*.epub"));
});

test("hierarchy, aliases, and XML roots survive generation", () => {
  assert.equal(entry("application/vnd.oasis.opendocument.text").supertype, "application/zip");
  const rss = TIKA_MIME_REGISTRY.find((candidate) =>
    candidate.rootXml.some((root) => root.localName === "rss"),
  );
  assert.ok(rss);
  assert.ok(
    TIKA_MIME_REGISTRY.some((candidate) => candidate.aliases.length > 0),
  );
});

test("magic rules preserve priority and nesting", () => {
  const riff = TIKA_MIME_REGISTRY.find((candidate) =>
    candidate.magic.some((magic) =>
      magic.matches.some(
        (match) =>
          match.value === "RIFF" &&
          (match.children?.length ?? 0) > 0,
      ),
    ),
  );
  assert.ok(riff);
  assert.ok(
    TIKA_MIME_REGISTRY.every((candidate) =>
      candidate.magic.every((magic) => magic.priority >= 0),
    ),
  );
});
