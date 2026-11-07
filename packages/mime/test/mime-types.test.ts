import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType } from "@spikedpunch/ripstream-core";
import {
  MimeTypes,
  TIKA_MIME_REGISTRY,
  filenameFromContentDisposition,
} from "../src/index.ts";

const mimeTypes = new MimeTypes();

test("resolves common document names", () => {
  assert.equal(mimeTypes.forName("report.pdf")?.toString(), "application/pdf");
  assert.equal(
    mimeTypes.forName("report.docx")?.toString(),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(mimeTypes.forName("book.epub")?.toString(), "application/epub+zip");
  assert.equal(mimeTypes.forName("archive.tar.gz")?.toString(), "application/gzip");
});

test("unknown names fall back to octet-stream only through the explicit API", () => {
  assert.equal(mimeTypes.forName("file.unknown-extension"), null);
  assert.deepEqual(mimeTypes.getMimeTypeOrOctetStream("file.unknown-extension"), MediaType.OCTET_STREAM);
});

test("normalizes aliases", () => {
  const aliased = TIKA_MIME_REGISTRY.find((entry) => entry.aliases.length > 0);
  assert.ok(aliased);
  const alias = MediaType.parse(aliased.aliases[0]!);
  assert.ok(alias);
  assert.equal(
    mimeTypes.getRegisteredMimeType(alias)?.toString(),
    MediaType.parse(aliased.type)?.toString(),
  );
});

test("exposes upstream supertypes and specialization", () => {
  const odt = MediaType.parse("application/vnd.oasis.opendocument.text");
  assert.ok(odt);
  assert.equal(mimeTypes.getSupertype(odt)?.toString(), "application/zip");
  assert.equal(mimeTypes.isSpecializationOf(odt, MediaType.APPLICATION_ZIP), true);
});

test("glob matching is case-sensitive and extension-priority based", () => {
  assert.equal(mimeTypes.forName("FILE.PDF"), null);
  assert.equal(mimeTypes.forName("x.pdf")?.toString(), "application/pdf");
});

test("root XML lookup maps known roots", () => {
  const rss = TIKA_MIME_REGISTRY.find((entry) =>
    entry.rootXml.some((root) => root.localName === "rss"),
  );
  assert.ok(rss);
  assert.equal(
    mimeTypes.forRootXML("rss")?.toString(),
    MediaType.parse(rss.type)?.toString(),
  );
});

test("parses Content-Disposition filenames", () => {
  assert.equal(
    filenameFromContentDisposition('attachment; filename="report.pdf"'),
    "report.pdf",
  );
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''na%C3%AFve.txt"),
    "naïve.txt",
  );
  assert.equal(
    filenameFromContentDisposition("attachment; filename=plain.txt"),
    "plain.txt",
  );
  assert.equal(filenameFromContentDisposition("inline"), null);
});

test("custom mimetypes merge and override the registry", () => {
  const mimeTypes = new MimeTypes({
    custom: [
      { type: "application/x-widget", globs: ["*.widget"], aliases: ["application/widget"] },
      { type: "text/plain", globs: ["*.txt"], override: true },
    ],
  });
  assert.equal(mimeTypes.forName("thing.widget")?.toString(), "application/x-widget");
  assert.equal(mimeTypes.forName("notes.txt")?.toString(), "text/plain");
  assert.equal(
    mimeTypes.normalize(MediaType.parse("application/widget")!)?.toString(),
    "application/x-widget",
  );
});
