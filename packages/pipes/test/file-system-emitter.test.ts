import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { gunzipSync } from "node:zlib";
import { serializeRmeta } from "@spikedpunch/ripstream-core";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { FileSystemEmitter, FlatFileEmitter, jacksonPretty, type EmittedDocument } from "../src/index.ts";

/*
 * Tika's FileSystemEmitter, read from its source: the output is basePath/emitKey (nested directories, an emit key that
 * leaves basePath is refused), onExists decides what a second write to a file does, a write goes to a temporary file
 * and is renamed into place unless atomicWrites is off, GZIP adds `.gz`, and an RMETA document is a JSON list.
 */

async function scratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ripstream-fs-emitter-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const concatenated = (id: string, text: string, metadata: Record<string, string> = { "Content-Type": "text/plain", "tk:content-handler-type": "text" }): EmittedDocument => ({
  id,
  mode: "CONCATENATE",
  text,
  metadata,
});

test("the output mirrors the emit key under basePath, creating the directories", async () => {
  await scratch(async (directory) => {
    const emitter = new FileSystemEmitter({ basePath: directory, fileExtension: "json" });
    await emitter.emit(concatenated("a/b/doc.txt", "x"));
    const written = JSON.parse(await readFile(join(directory, "a", "b", "doc.txt.json"), "utf8")) as Array<Record<string, string>>;
    assert.equal(written[0]?.["tk:content"], "x");
  });
});

test("without a fileExtension the file is named by the emit key alone", async () => {
  await scratch(async (directory) => {
    await new FileSystemEmitter({ basePath: directory }).emit(concatenated("doc.txt", "x"));
    assert.deepEqual(await readdir(directory), ["doc.txt"]);
  });
});

test("an emit key that leaves basePath is refused, as `path traversal?!`", async () => {
  await scratch(async (directory) => {
    const base = join(directory, "out");
    await mkdir(base);
    const emitter = new FileSystemEmitter({ basePath: base });
    for (const key of ["../escape.json", "a/../../escape.json", "/etc/escape.json"]) {
      await assert.rejects(emitter.emit(concatenated(key, "x")), /^Error: path traversal\?! /, key);
    }
    assert.deepEqual(await readdir(directory), ["out"]);
    assert.deepEqual(await readdir(base), []);
  });
});

test("a basePath is needed unless allowAbsolutePaths says a key may name any file", async () => {
  assert.throws(() => new FileSystemEmitter({}), /'basePath' must be set, or 'allowAbsolutePaths' must be true/);
  assert.throws(() => new FileSystemEmitter({ basePath: "  " }), /'basePath' must be set/);
  await scratch(async (directory) => {
    await new FileSystemEmitter({ allowAbsolutePaths: true }).emit(concatenated(join(directory, "free.json"), "x"));
    assert.deepEqual(await readdir(directory), ["free.json"]);
  });
});

test("onExists EXCEPTION is the default: a second write fails with Tika's message and leaves the first", async () => {
  await scratch(async (directory) => {
    const emitter = new FileSystemEmitter({ basePath: directory });
    await emitter.emit(concatenated("doc", "first"));
    await assert.rejects(
      emitter.emit(concatenated("doc", "second")),
      new RegExp(
        `^Error: Output already exists \\(onExists=EXCEPTION, not overwritten\\): ${join(directory, "doc").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Use an empty output dir, delete the file, or set onExists to REPLACE or SKIP\\.$`,
      ),
    );
    assert.match(await readFile(join(directory, "doc"), "utf8"), /first/);
    // The refused write left nothing behind.
    assert.deepEqual(await readdir(directory), ["doc"]);
  });
});

test("onExists SKIP leaves the first file and says nothing; REPLACE overwrites it", async () => {
  await scratch(async (directory) => {
    const skipping = new FileSystemEmitter({ basePath: directory, onExists: "SKIP" });
    await skipping.emit(concatenated("doc", "first"));
    await skipping.emit(concatenated("doc", "second"));
    assert.match(await readFile(join(directory, "doc"), "utf8"), /first/);
    assert.deepEqual(await readdir(directory), ["doc"]);

    await new FileSystemEmitter({ basePath: directory, onExists: "REPLACE" }).emit(concatenated("doc", "second"));
    assert.match(await readFile(join(directory, "doc"), "utf8"), /second/);
    assert.deepEqual(await readdir(directory), ["doc"]);
  });
});

test("onExists holds with atomicWrites off, too", async () => {
  await scratch(async (directory) => {
    for (const [onExists, expected] of [["EXCEPTION", "first"], ["SKIP", "first"], ["REPLACE", "second"]] as const) {
      const name = `doc-${onExists}`;
      const emitter = new FileSystemEmitter({ basePath: directory, onExists, atomicWrites: false });
      await emitter.emit(concatenated(name, "first"));
      const second = emitter.emit(concatenated(name, "second"));
      if (onExists === "EXCEPTION") await assert.rejects(second, /Output already exists \(onExists=EXCEPTION/);
      else await second;
      assert.match(await readFile(join(directory, name), "utf8"), new RegExp(expected), onExists);
    }
  });
});

test("a write goes to a sibling temporary file first and only the finished file is ever the output", async () => {
  await scratch(async (directory) => {
    const seen: string[][] = [];
    const real = fsp.link;
    const spy = mock.method(fsp, "link", async (existing: string, target: string) => {
      seen.push(await readdir(directory));
      return real(existing, target);
    });
    try {
      await new FileSystemEmitter({ basePath: directory }).emit(concatenated("doc", "x"));
    } finally {
      spy.mock.restore();
    }
    // At the moment of publishing, the content sat in `doc.<uuid>.tmp` and `doc` did not exist yet.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.length, 1);
    assert.match(seen[0]![0]!, /^doc\.[0-9a-f-]{36}\.tmp$/);
    assert.deepEqual(await readdir(directory), ["doc"]);
  });
});

test("with REPLACE the temporary file is renamed over the old one, and a failed write leaves the old file whole", async () => {
  await scratch(async (directory) => {
    await writeFile(join(directory, "doc"), "old");
    const emitter = new FileSystemEmitter({ basePath: directory, onExists: "REPLACE" });
    const spy = mock.method(fsp, "rename", async () => {
      throw new Error("disk full");
    });
    try {
      await assert.rejects(emitter.emit(concatenated("doc", "new")), /disk full/);
    } finally {
      spy.mock.restore();
    }
    assert.equal(await readFile(join(directory, "doc"), "utf8"), "old");
    assert.deepEqual(await readdir(directory), ["doc"], "the temporary file is removed after the failure");
  });
});

test("a file system without hard links still gets a no-clobber publish: it checks, then renames", async () => {
  await scratch(async (directory) => {
    const spy = mock.method(fsp, "link", async () => {
      throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    });
    try {
      const emitter = new FileSystemEmitter({ basePath: directory });
      await emitter.emit(concatenated("doc", "first"));
      await assert.rejects(emitter.emit(concatenated("doc", "second")), /Output already exists/);
      assert.match(await readFile(join(directory, "doc"), "utf8"), /first/);
      assert.deepEqual(await readdir(directory), ["doc"]);
    } finally {
      spy.mock.restore();
    }
  });
});

test("GZIP adds .gz to the name and the file reads back through gunzip", async () => {
  await scratch(async (directory) => {
    await new FileSystemEmitter({ basePath: directory, fileExtension: "json", compression: "GZIP" }).emit(concatenated("doc", "zipped"));
    assert.deepEqual(await readdir(directory), ["doc.json.gz"]);
    const text = gunzipSync(await readFile(join(directory, "doc.json.gz"))).toString("utf8");
    assert.equal((JSON.parse(text) as Array<Record<string, string>>)[0]?.["tk:content"], "zipped");
  });
});

test("prettyPrint writes Jackson's layout: `key : value`, two spaces a level, an array on one line", async () => {
  await scratch(async (directory) => {
    await new FileSystemEmitter({ basePath: directory, prettyPrint: true }).emit(
      concatenated("doc", "hi", { "Content-Type": "text/plain", "tk:content-handler-type": "text" }),
    );
    const text = await readFile(join(directory, "doc"), "utf8");
    assert.equal(
      text,
      '[ {\n  "Content-Type" : "text/plain",\n  "tk:content-handler-type" : "text",\n  "tk:content" : "hi"\n} ]',
    );
  });
});

test("jacksonPretty: arrays on one line, `{ }` and `[ ]` when empty, only objects start a level", () => {
  assert.equal(
    jacksonPretty([{ a: ["x", "y"], b: {}, c: [], d: { e: 1, f: [true, null] } }, { g: 2 }]),
    '[ {\n  "a" : [ "x", "y" ],\n  "b" : { },\n  "c" : [ ],\n  "d" : {\n    "e" : 1,\n    "f" : [ true, null ]\n  }\n}, {\n  "g" : 2\n} ]',
  );
});

test("compact output is a one-line JSON list", async () => {
  await scratch(async (directory) => {
    await new FileSystemEmitter({ basePath: directory }).emit(concatenated("doc", "hi"));
    const text = await readFile(join(directory, "doc"), "utf8");
    assert.equal(text, '[{"Content-Type":"text/plain","tk:content-handler-type":"text","tk:content":"hi"}]');
  });
});

test("an RMETA document is written from its records, as the list /rmeta answers", async () => {
  await scratch(async (directory) => {
    // The records are the source of truth: `text` is for emitters that want a string, and is not what is written.
    const records = await createRipstream().parseRecursive(new TextEncoder().encode("body"), { filename: "doc.txt" });
    await new FileSystemEmitter({ basePath: directory }).emit({ id: "doc", mode: "RMETA", text: "not what is written", records });
    assert.equal(await readFile(join(directory, "doc"), "utf8"), serializeRmeta(records));
  });
});

test("CONTENT_ONLY writes the raw content and nothing else, with the extension", async () => {
  await scratch(async (directory) => {
    await new FileSystemEmitter({ basePath: directory, fileExtension: "txt" }).emit({
      id: "doc",
      mode: "CONTENT_ONLY",
      text: "just the text",
      metadata: { "Content-Type": "text/plain" },
    });
    assert.equal(await readFile(join(directory, "doc.txt"), "utf8"), "just the text");
  });
});

test("embedded bytes are written as they are, under their own key: no extension, no compression", async () => {
  await scratch(async (directory) => {
    const emitter = new FileSystemEmitter({ basePath: directory, fileExtension: "json", compression: "GZIP" });
    await emitter.emit({ id: "doc-embed/1", mode: "UNPACK", bytes: Uint8Array.of(1, 2, 3) });
    assert.deepEqual([...(await readFile(join(directory, "doc-embed", "1")))], [1, 2, 3]);
  });
});

test("a document with neither bytes nor text nor metadata is an error, not an empty file", async () => {
  await scratch(async (directory) => {
    await assert.rejects(new FileSystemEmitter({ basePath: directory }).emit({ id: "doc" }), /nothing to write/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("the output path is not resolved through symbolic links (as Tika's): a link inside basePath is followed", async () => {
  await scratch(async (directory) => {
    const base = join(directory, "out");
    const elsewhere = join(directory, "elsewhere");
    await mkdir(base);
    await mkdir(elsewhere);
    await symlink(elsewhere, join(base, "link"));
    await new FileSystemEmitter({ basePath: base }).emit(concatenated("link/doc", "x"));
    assert.ok((await stat(join(elsewhere, "doc"))).isFile());
  });
});

test("FlatFileEmitter keeps the shorthand layout: one flat file per id, distinct unsafe ids in distinct files", async () => {
  await scratch(async (directory) => {
    const emitter = new FlatFileEmitter(directory);
    await emitter.emit({ id: "a/b", text: "one" });
    await emitter.emit({ id: "a_b", text: "two" });
    await emitter.emit({ id: "raw", bytes: Uint8Array.of(7) });
    const names = (await readdir(directory)).sort();
    assert.equal(names.length, 3);
    assert.ok(names.includes("a_b.txt"));
    assert.ok(names.includes("raw.bin"));
    assert.ok(names.some((name) => /^a_b-[0-9a-f]{8}\.txt$/.test(name)));
  });
});
