import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  MediaType,
  Metadata,
  Ripstream,
  RipstreamInputStream,
  rmetaObjects,
  type ContentHandler,
  type Detector,
  type EmbeddedDocumentExtractor,
  type ParseContext,
  type Parser,
  type PathPart,
} from "../src/index.ts";

const detector: Detector = { detect: async () => MediaType.TEXT_PLAIN };

/** What each fake document holds, by its resource name: archives hand out entries, documents embed resources. */
const TREE: Record<string, { readonly archive: boolean; readonly children: readonly string[] }> = {
  "zip-000.zip": { archive: true, children: ["data/export-0.csv", "nested/inner.zip", "report.docx"] },
  "nested/inner.zip": { archive: true, children: ["data/export-0.csv"] },
  "report.docx": { archive: false, children: ["image1.png"] },
};

async function emit(name: string, handler: ContentHandler, ctx: ParseContext, archive: boolean): Promise<void> {
  const extractor = ctx.get(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR) as EmbeddedDocumentExtractor;
  const embedded = new Metadata();
  embedded.set("tk:resource-name", name);
  // An archive parser marks its own context, as parser-archive's markArchiveEntries does.
  if (archive) ctx.set(CONTEXT_KEYS.ARCHIVE_ENTRY, true);
  await extractor.parseEmbedded(await RipstreamInputStream.from(new Uint8Array([1])), handler, embedded, ctx);
}

const treeParser: Parser = {
  name: "Tree",
  getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
  async parse(stream, handler, metadata, ctx): Promise<void> {
    for await (const _chunk of stream) { /* read it all */ }
    const node = TREE[metadata.get("tk:resource-name") ?? ""];
    for (const child of node?.children ?? []) await emit(child, handler, ctx, node?.archive ?? false);
  },
};

const ripstream = new Ripstream({ detector, parser: treeParser });

test("pathParts names each step whole: an entry name with '/' is one part, nested archives are entries of entries", async () => {
  const records = await ripstream.parseRecursive(new Uint8Array([9]), { filename: "zip-000.zip" });
  assert.deepEqual(
    records.map((record) => record.pathParts),
    [
      [{ kind: "root", name: "zip-000.zip" }],
      [{ kind: "root", name: "zip-000.zip" }, { kind: "entry", name: "data/export-0.csv" }],
      [{ kind: "root", name: "zip-000.zip" }, { kind: "entry", name: "nested/inner.zip" }],
      [
        { kind: "root", name: "zip-000.zip" },
        { kind: "entry", name: "nested/inner.zip" },
        { kind: "entry", name: "data/export-0.csv" },
      ],
      [{ kind: "root", name: "zip-000.zip" }, { kind: "entry", name: "report.docx" }],
      [
        { kind: "root", name: "zip-000.zip" },
        { kind: "entry", name: "report.docx" },
        { kind: "embedded", name: "image1.png" },
      ],
    ] satisfies PathPart[][],
  );
});

test("the names of pathParts joined with '/' are embeddedResourcePath, and the parts below the root the Tika key", async () => {
  const records = await ripstream.parseRecursive(new Uint8Array([9]), { filename: "zip-000.zip" });
  for (const record of records) {
    const parts = record.pathParts ?? [];
    assert.equal(`/${parts.map((part) => part.name).join("/")}`.replace(/\/+/g, "/"), record.embeddedResourcePath);
    if (record.depth > 0) {
      assert.equal(`/${parts.slice(1).map((part) => part.name).join("/")}`, record.metadata.get("tk:embedded-resource-path"));
    }
  }
});

test("a root named by a URL keeps its whole name as its part", async () => {
  const [root] = await ripstream.parseRecursive(new Uint8Array([9]), { filename: "https://example.com/a/b.txt" });
  assert.equal(root?.embeddedResourcePath, "/https:/example.com/a/b.txt");
  assert.deepEqual(root?.pathParts, [{ kind: "root", name: "https://example.com/a/b.txt" }]);
});

test("pathParts is frozen", async () => {
  const records = await ripstream.parseRecursive(new Uint8Array([9]), { filename: "zip-000.zip" });
  assert.ok(Object.isFrozen(records[1]?.pathParts));
  assert.ok(Object.isFrozen(records[1]?.pathParts?.[1]));
});

test("rmeta output carries no pathParts: the Tika-shaped JSON is unchanged", async () => {
  const records = await ripstream.parseRecursive(new Uint8Array([9]), { filename: "zip-000.zip" });
  for (const object of rmetaObjects(records)) {
    assert.ok(!Object.keys(object).some((key) => /path-?parts/i.test(key)), JSON.stringify(Object.keys(object)));
  }
  assert.equal(rmetaObjects(records)[1]?.["tk:embedded-resource-path"], "/data/export-0.csv");
});
