import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError, MediaType, Metadata, type ParseRecord } from "@spikedpunch/ripstream-core";
import { buildUnpackPackage, packageName, zipChunks, type UnpackInput } from "../src/frictionless.ts";
import { readZip } from "./fixtures/zip.ts";

/*
 * The package `/unpack` answers and pipes' UNPACK emits: Tika's "frictionless" zip (datapackage.json, rmeta.json, unpacked/<id><ext>). The
 * shapes below are those of the responses Tika 4.2.0 gave, saved in tasks/parity/server/differential.json (r164-r173).
 */

const WHEN = new Date(Date.UTC(2026, 10, 9, 18, 44, 43, 999));

function record(depth: number, fields: Record<string, string>, bytes?: Uint8Array): ParseRecord {
  return {
    metadata: new Metadata(fields),
    content: "",
    embeddedResourcePath: depth === 0 ? "" : `/${fields["tk:resource-name"] ?? "x"}`,
    depth,
    mediaType: MediaType.OCTET_STREAM,
    exception: null,
    ...(bytes === undefined ? {} : { bytes }),
  };
}

// What the registry of a server would give: the first extension of the registered type, .bin for the rest.
const EXTENSIONS: Readonly<Record<string, string>> = { "text/plain": ".txt", "image/png": ".png", "application/gzip": ".gz" };
const nameOf = (id: number, entry: ParseRecord): string => `${id}${EXTENSIONS[entry.metadata.get("Content-Type") ?? ""] ?? ".bin"}`;
const sha = (hex: string): string => `sha256:${hex}`;
const rmeta = new TextEncoder().encode('[{"a":"b"}]\n');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function input(over: Partial<UnpackInput>): UnpackInput {
  return {
    records: [record(0, { "Content-Type": "application/zip" })],
    container: null,
    filename: undefined,
    rmeta,
    nameOf,
    now: WHEN,
    ...over,
  };
}

const manifestOf = (over: Partial<UnpackInput>): string => {
  const [first] = buildUnpackPackage(input(over)).files;
  assert.equal(first?.path, "datapackage.json");
  return new TextDecoder().decode(first?.bytes);
};

// ---- the package's name -------------------------------------------------------------------------------------------

test("packageName: lower case, [a-z0-9._-], runs of - folded; none for no name (r173: doc.docx)", () => {
  assert.equal(packageName("doc.docx"), "doc.docx");
  assert.equal(packageName("My Doc (1).DOCX"), "my-doc-1-.docx");
  assert.equal(packageName("a///b"), "a-b");
  assert.equal(packageName(undefined), null);
  assert.equal(packageName("  "), null);
});

// ---- datapackage.json --------------------------------------------------------------------------------------------

test("datapackage.json has Jackson's layout: created, resources, rmeta first, then the embedded documents in id order", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const note = utf8("hello");
  const text = manifestOf({
    records: [
      record(0, { "Content-Type": "application/zip" }),
      // Out of order, as Tika's records are: the package orders by embedded id.
      record(1, { "tk:embedded-id": "2", "tk:resource-name": "note.txt", "Content-Type": "text/plain" }, note),
      record(1, { "tk:embedded-id": "1", "tk:resource-name": "inner/pic.png", "Content-Type": "image/png" }, png),
    ],
  });
  const expected = `{
  "created" : "2026-11-09T18:44:43Z",
  "resources" : [ {
    "name" : "rmeta.json",
    "path" : "rmeta.json",
    "mediatype" : "application/json",
    "bytes" : 12,
    "hash" : "${sha("ignored")}"
  }, {
    "name" : "unpacked-1.png",
    "path" : "unpacked/1.png",
    "mediatype" : "image/png",
    "bytes" : 4,
    "hash" : "${sha("ignored")}",
    "tk:embedded-id" : 1,
    "tk:resource-name" : "inner/pic.png"
  }, {
    "name" : "unpacked-2.txt",
    "path" : "unpacked/2.txt",
    "mediatype" : "text/plain",
    "bytes" : 5,
    "hash" : "${sha("ignored")}",
    "tk:embedded-id" : 2,
    "tk:resource-name" : "note.txt"
  } ]
}`;
  // The hashes are of the bytes: check them against the shape, then against crypto.
  const shape = (value: string): string => value.replace(/sha256:[0-9a-f]{64}/g, "sha256:H").replace(/sha256:ignored/g, "sha256:H");
  assert.equal(shape(text), shape(expected));
  assert.ok(!text.endsWith("\n"), "Jackson writes no newline at the end");
});

test("datapackage.json hashes the bytes of every file with sha256", async () => {
  const { createHash } = await import("node:crypto");
  const body = utf8("hello");
  const pkg = buildUnpackPackage(input({ records: [record(0, {}), record(1, { "tk:embedded-id": "1", "Content-Type": "text/plain" }, body)] }));
  const manifest = JSON.parse(new TextDecoder().decode(pkg.files[0]?.bytes)) as { resources: Array<{ path: string; hash: string; bytes: number }> };
  const hex = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.deepEqual(
    manifest.resources.map((r) => [r.path, r.hash, r.bytes]),
    [
      ["rmeta.json", hex(rmeta), rmeta.length],
      ["unpacked/1.txt", hex(body), 5],
    ],
  );
});

test("the package is named after the document's name when the request gave one, and not otherwise; name comes first", () => {
  assert.match(manifestOf({ filename: "Doc One.docx" }), /^\{\n {2}"name" : "doc-one.docx",\n {2}"created" : /);
  assert.match(manifestOf({}), /^\{\n {2}"created" : /);
});

test("tk:resource-name is left out for an embedded document that had no name", () => {
  const text = manifestOf({ records: [record(0, {}), record(1, { "tk:embedded-id": "1", "Content-Type": "text/plain" }, utf8("x"))] });
  assert.doesNotMatch(text, /tk:resource-name/);
  assert.match(text, /"tk:embedded-id" : 1\n/);
});

test("a type with parameters is .bin on disk and its bare type in the manifest (r166); no type is octet-stream", () => {
  const manifest = JSON.parse(
    manifestOf({
      records: [
        record(0, {}),
        record(1, { "tk:embedded-id": "1", "Content-Type": "text/plain; charset=windows-1252" }, utf8("a")),
        record(1, { "tk:embedded-id": "2" }, utf8("b")),
      ],
    }),
  ) as { resources: Array<{ name: string; path: string; mediatype: string }> };
  assert.deepEqual(
    manifest.resources.slice(1).map((r) => [r.name, r.path, r.mediatype]),
    [
      ["unpacked-1.bin", "unpacked/1.bin", "text/plain"],
      ["unpacked-2.bin", "unpacked/2.bin", "application/octet-stream"],
    ],
  );
});

test("an embedded document the parse kept no bytes for is not in the package", () => {
  const pkg = buildUnpackPackage(
    input({ records: [record(0, {}), record(1, { "tk:embedded-id": "1" }), record(1, { "tk:embedded-id": "2", "Content-Type": "text/plain" }, utf8("kept"))] }),
  );
  assert.deepEqual(
    pkg.files.map((file) => file.path),
    ["datapackage.json", "rmeta.json", "unpacked/2.txt"],
  );
});

test("a document with nothing embedded is a package of the two manifests (r167)", () => {
  assert.deepEqual(
    buildUnpackPackage(input({})).files.map((file) => file.path),
    ["datapackage.json", "rmeta.json"],
  );
});

test("/all adds the document itself as unpacked/0, id 0, no resource name, ahead of the embedded ones (r170)", () => {
  const container = utf8("PK-container");
  const pkg = buildUnpackPackage(
    input({
      records: [record(0, { "Content-Type": "image/png" }), record(1, { "tk:embedded-id": "1", "tk:resource-name": "a", "Content-Type": "text/plain" }, utf8("a"))],
      container,
    }),
  );
  assert.deepEqual(
    pkg.files.map((file) => file.path),
    ["datapackage.json", "rmeta.json", "unpacked/0.png", "unpacked/1.txt"],
  );
  const manifest = new TextDecoder().decode(pkg.files[0]?.bytes);
  assert.match(manifest, /"path" : "unpacked\/0.png",\n {4}"mediatype" : "image\/png",\n {4}"bytes" : 12,\n {4}"hash" : "sha256:[0-9a-f]{64}",\n {4}"tk:embedded-id" : 0\n {2}\}/);
});

test("resource names are lower case, [a-z0-9._-]: the path with / and other characters as -", () => {
  const manifest = JSON.parse(
    manifestOf({ records: [record(0, {}), record(1, { "tk:embedded-id": "12", "Content-Type": "text/plain" }, utf8("a"))], nameOf: (id) => `${id}.C++` }),
  ) as { resources: Array<{ name: string; path: string }> };
  assert.deepEqual(manifest.resources[1], { ...manifest.resources[1], name: "unpacked-12.c--", path: "unpacked/12.C++" });
});

test("a hostile resource name stays inside the manifest as data: it never becomes a path", () => {
  const pkg = buildUnpackPackage(
    input({
      records: [
        record(0, {}),
        record(1, { "tk:embedded-id": "1", "tk:resource-name": "../../etc/evil.txt", "Content-Type": "text/plain" }, utf8("x")),
        record(1, { "tk:embedded-id": "2", "tk:resource-name": '/abs/"quoted".txt\n', "Content-Type": "text/plain" }, utf8("y")),
      ],
    }),
  );
  assert.deepEqual(
    pkg.files.map((file) => file.path),
    ["datapackage.json", "rmeta.json", "unpacked/1.txt", "unpacked/2.txt"],
  );
  const manifest = JSON.parse(new TextDecoder().decode(pkg.files[0]?.bytes)) as { resources: Array<Record<string, unknown>> };
  assert.equal(manifest.resources[1]?.["tk:resource-name"], "../../etc/evil.txt");
  assert.equal(manifest.resources[2]?.["tk:resource-name"], '/abs/"quoted".txt\n');
});

test("more files than a zip can name is a LimitExceededError, not a corrupt archive", () => {
  const records = [record(0, {})];
  for (let id = 1; id <= 0xffff; id++) records.push(record(1, { "tk:embedded-id": String(id) }, new Uint8Array(0)));
  assert.throws(() => buildUnpackPackage(input({ records })), LimitExceededError);
});

test("a package that could outgrow a zip's 32-bit offsets is refused before the answer starts", () => {
  // Two documents that claim 2 GiB each: the bound is on what they could take, so no 4 GiB buffer is needed to say it.
  const claiming = (size: number): Uint8Array => Object.defineProperty(new Uint8Array(1), "length", { value: size });
  const records = [record(0, {}), record(1, { "tk:embedded-id": "1" }, claiming(2 ** 31)), record(1, { "tk:embedded-id": "2" }, claiming(2 ** 31))];
  assert.throws(
    () => buildUnpackPackage(input({ records })),
    (error: unknown) => error instanceof LimitExceededError && /lower maxUnpackBytes/.test(error.message),
  );
  const fits = [record(0, {}), record(1, { "tk:embedded-id": "1" }, claiming(2 ** 31))];
  assert.equal(buildUnpackPackage(input({ records: fits })).files.length, 3);
});

// ---- the zip -------------------------------------------------------------------------------------------------------

async function bytesOf(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

test("the zip is what a strict reader reads: entries in order, deflated, UTF-8 names, a data descriptor each", async () => {
  const big = Buffer.alloc(300_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 9)) & 0xff;
  const pkg = buildUnpackPackage(
    input({
      records: [
        record(0, {}),
        record(1, { "tk:embedded-id": "1", "Content-Type": "image/png" }, big),
        record(1, { "tk:embedded-id": "2", "Content-Type": "text/plain" }, new Uint8Array(0)),
        record(1, { "tk:embedded-id": "3", "Content-Type": "text/plain" }, utf8("héllo wörld")),
      ],
    }),
  );
  const entries = readZip(await bytesOf(zipChunks(pkg)));
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["datapackage.json", "rmeta.json", "unpacked/1.png", "unpacked/2.txt", "unpacked/3.txt"],
  );
  for (const entry of entries) {
    assert.equal(entry.flags, 0x0808, `${entry.name}: UTF-8 names and a data descriptor, as Tika's entries`);
    assert.equal(entry.method, 8, `${entry.name}: deflated`);
  }
  assert.equal(Buffer.compare(entries[2]?.data ?? Buffer.alloc(0), big), 0);
  assert.equal(entries[3]?.data.length, 0);
  assert.equal(entries[4]?.data.toString("utf8"), "héllo wörld");
  assert.deepEqual([...(entries[1]?.data ?? [])], [...rmeta]);
});

test("every entry carries the package's time, in UTC", async () => {
  const entries = readZip(await bytesOf(zipChunks(buildUnpackPackage(input({})))));
  for (const entry of entries) {
    assert.equal(entry.date, ((2026 - 1980) << 9) | (11 << 5) | 9);
    assert.equal(entry.time, (18 << 11) | (44 << 5) | (43 >> 1));
  }
});

test("a file name that is not ASCII is a UTF-8 name", async () => {
  const pkg = { files: [{ path: "unpacked/é-日本.bin", bytes: utf8("x") }], created: WHEN };
  assert.equal(readZip(await bytesOf(zipChunks(pkg)))[0]?.name, "unpacked/é-日本.bin");
});

test("the zip is written a file at a time: the second file is not touched until the first is out", async () => {
  let secondReads = 0;
  const second = {
    get bytes(): Uint8Array {
      secondReads++;
      return utf8("y");
    },
    path: "b.bin",
  };
  const chunks = zipChunks({ files: [{ path: "a.bin", bytes: utf8("x") }, second], created: WHEN });
  await chunks.next();
  assert.equal(secondReads, 0);
  const rest = await bytesOf(chunks);
  assert.ok(secondReads > 0 && rest.length > 0);
});
