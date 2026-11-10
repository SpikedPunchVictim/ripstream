import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer, type ServerIsolationStatus, type ServerMimeType } from "../src/index.ts";
import { readZip, storedZip, type ZipEntry } from "./fixtures/zip.ts";

/*
 * /unpack answers Tika's "frictionless" package: a zip of datapackage.json, rmeta.json and unpacked/<id><extension>
 * (tasks/parity/server/differential.json r164-r177, r224). What it does not do, by decision: a config part, the
 * REGULAR and DIRECTORY formats, selectors and presets (tikajs-68os.7.4).
 */

const registry: ServerMimeType[] = [
  { type: "application/zip", extensions: [".zip"] },
  { type: "text/plain", extensions: [".txt"] },
  { type: "text/html", extensions: [".html"] },
  { type: "application/xml", extensions: [".xml"] },
];

async function withServer<T>(
  run: (base: string) => Promise<T>,
  options: Parameters<typeof createRipstreamServer>[0] = {},
): Promise<T> {
  const instance = createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, mimeTypes: registry, ...options });
  const port = await instance.listen();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await instance.close();
  }
}

const inner = storedZip({ "c/inner.txt": "inner text", "d.xml": "<a>b</a>" });
const container = storedZip({ "a.txt": "first document", "inner/bundle.zip": inner, "top.html": "<p>top</p>" });

interface Manifest {
  readonly name?: string;
  readonly created: string;
  readonly resources: Array<{
    name: string;
    path: string;
    mediatype: string;
    bytes: number;
    hash: string;
    "tk:embedded-id"?: number;
    "tk:resource-name"?: string;
  }>;
}

async function unpacked(response: Response): Promise<{ entries: ZipEntry[]; manifest: Manifest; rmeta: Array<Record<string, unknown>> }> {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "application/zip");
  const entries = readZip(new Uint8Array(await response.arrayBuffer()));
  const manifest = JSON.parse(entries[0]?.data.toString("utf8") ?? "") as Manifest;
  const rmeta = JSON.parse(entries[1]?.data.toString("utf8") ?? "") as Array<Record<string, unknown>>;
  return { entries, manifest, rmeta };
}

const put = (base: string, path: string, body: Uint8Array | string = container, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: "PUT", body, headers });

test("PUT /unpack answers a zip: datapackage.json, rmeta.json, then every embedded document as unpacked/<id><ext>", async () => {
  await withServer(async (base) => {
    const { entries, manifest, rmeta } = await unpacked(await put(base, "/unpack"));
    const names = entries.map((entry) => entry.name);
    assert.equal(names[0], "datapackage.json");
    assert.equal(names[1], "rmeta.json");
    assert.equal(names.length, 2 + 5, "a.txt, the nested zip, its two documents and top.html");
    assert.ok(names.slice(2).every((name) => /^unpacked\/\d+\.[a-z]+$/.test(name)), names.join(", "));

    // The manifest describes what is in the zip: the same bytes and the same sha256.
    assert.equal(manifest.resources[0]?.path, "rmeta.json");
    assert.equal(manifest.resources[0]?.mediatype, "application/json");
    const { createHash } = await import("node:crypto");
    for (const [index, resource] of manifest.resources.entries()) {
      const entry = entries[index + 1];
      assert.equal(entry?.name, resource.path);
      assert.equal(entry?.data.length, resource.bytes);
      assert.equal(resource.hash, `sha256:${createHash("sha256").update(entry?.data ?? Buffer.alloc(0)).digest("hex")}`);
    }

    // The documents are those of the container, as the records of rmeta.json name them.
    const embedded = manifest.resources.slice(1);
    assert.deepEqual(
      embedded.map((resource) => resource["tk:embedded-id"]),
      [...embedded.map((resource) => resource["tk:embedded-id"])].sort((a, b) => (a ?? 0) - (b ?? 0)),
      "in id order",
    );
    const byName = new Map(embedded.map((resource) => [resource["tk:resource-name"], resource]));
    const bytesOf = (name: string): string => {
      const path = byName.get(name)?.path;
      return entries.find((entry) => entry.name === path)?.data.toString("utf8") ?? "<missing>";
    };
    assert.equal(bytesOf("a.txt"), "first document");
    assert.equal(bytesOf("top.html"), "<p>top</p>");
    assert.equal(bytesOf("d.xml"), "<a>b</a>");
    assert.equal(Buffer.compare(entries.find((entry) => entry.name === byName.get("inner/bundle.zip")?.path)?.data ?? Buffer.alloc(0), inner), 0);
    assert.equal(rmeta.length, 6, "rmeta.json is the container and its five documents, as /rmeta answers");
  });
});

test("the extension is that of the registered type; a type with parameters is .bin, as Tika's (r165, r166)", async () => {
  await withServer(async (base) => {
    const { manifest, rmeta } = await unpacked(await put(base, "/unpack"));
    for (const resource of manifest.resources.slice(1)) {
      const record = rmeta.find((candidate) => candidate["tk:embedded-id"] === String(resource["tk:embedded-id"]));
      const contentType = String(record?.["Content-Type"] ?? "");
      const expected = contentType === "" || contentType.includes(";") ? ".bin" : (registry.find((type) => type.type === contentType)?.extensions?.[0] ?? ".bin");
      assert.equal(resource.path, `unpacked/${String(resource["tk:embedded-id"])}${expected}`, `${resource["tk:resource-name"]} (${contentType})`);
      assert.equal(resource.mediatype, contentType.split(";")[0]?.trim() || "application/octet-stream");
    }
    assert.ok(manifest.resources.some((resource) => resource.path.endsWith(".zip")), "the nested zip is a .zip");
  });
});

test("without a media type registry every embedded document is .bin", async () => {
  await withServer(
    async (base) => {
      const { manifest } = await unpacked(await put(base, "/unpack"));
      assert.ok(manifest.resources.slice(1).every((resource) => resource.path.endsWith(".bin")));
    },
    { mimeTypes: undefined },
  );
});

test("a request with no name has an unnamed package; ?filename= and a Content-Disposition name it (r164, r173)", async () => {
  await withServer(async (base) => {
    assert.equal((await unpacked(await put(base, "/unpack"))).manifest.name, undefined);
    assert.equal((await unpacked(await put(base, "/unpack?filename=My%20Box.zip"))).manifest.name, "my-box.zip");
    const named = await put(base, "/unpack", container, { "content-disposition": 'attachment; filename="Doc One.docx"' });
    assert.equal((await unpacked(named)).manifest.name, "doc-one.docx");
  });
});

test("created is the time of the request, in ISO UTC seconds", async () => {
  await withServer(async (base) => {
    const before = Date.now();
    const { manifest, entries } = await unpacked(await put(base, "/unpack"));
    assert.match(manifest.created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const stamped = Date.parse(manifest.created);
    assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000, manifest.created);
    assert.ok(entries.every((entry) => entry.date === entries[0]?.date));
  });
});

test("PUT /unpack/all adds the document itself as unpacked/0, id 0 and no resource name, first of the documents (r170)", async () => {
  await withServer(async (base) => {
    const { entries, manifest } = await unpacked(await put(base, "/unpack/all"));
    const [, zero] = manifest.resources;
    assert.equal(zero?.path, "unpacked/0.zip");
    assert.equal(zero?.["tk:embedded-id"], 0);
    assert.equal(zero?.["tk:resource-name"], undefined);
    assert.equal(zero?.mediatype, "application/zip");
    assert.equal(Buffer.compare(entries.find((entry) => entry.name === "unpacked/0.zip")?.data ?? Buffer.alloc(0), container), 0, "the request's own bytes");
    assert.equal(manifest.resources.length, 2 + 5);
    assert.equal((await unpacked(await put(base, "/unpack"))).manifest.resources.some((resource) => resource.path.startsWith("unpacked/0.")), false);
  });
});

test("/unpack/all/{handler} picks what rmeta.json's content is written as; a bad handler is 400 before anything is read (r171, r172)", async () => {
  await withServer(async (base) => {
    const html = await unpacked(await put(base, "/unpack/all/html"));
    assert.equal(html.rmeta[1]?.["tk:content-handler-type"], "HTML");
    assert.match(String(html.rmeta[1]?.["tk:content"]), /<p>/);
    const text = await unpacked(await put(base, "/unpack/all"));
    assert.equal(text.rmeta[1]?.["tk:content-handler-type"], "TEXT");

    const bogus = await put(base, "/unpack/all/bogus");
    assert.equal(bogus.status, 400);
    assert.match(await bogus.text(), /^Unrecognized handler type 'bogus'\. Valid types: /);
  });
});

test("POST /unpack takes the document as a multipart form, its file name naming the package (r173); a raw POST is 415 (r174)", async () => {
  await withServer(async (base) => {
    const boundary = "----ripstreamtest";
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="Box One.zip"\r\nContent-Type: application/octet-stream\r\n\r\n`, "latin1");
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "latin1");
    const form = { "content-type": `multipart/form-data; boundary=${boundary}` };
    for (const path of ["/unpack", "/unpack/all", "/unpack/all/text"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: form, body: Buffer.concat([head, Buffer.from(container), tail]) });
      const { manifest } = await unpacked(response);
      assert.equal(manifest.name, "box-one.zip", path);
      assert.equal(manifest.resources.length, path === "/unpack" ? 6 : 7, path);
    }

    const raw = await fetch(`${base}/unpack`, { method: "POST", body: container });
    assert.equal(raw.status, 415);
  });
});

test("Accept: only application/zip (and */*) is served; anything else is 406 with no body, before the body is read (r175)", async () => {
  await withServer(async (base) => {
    const json = await put(base, "/unpack", container, { accept: "application/json" });
    assert.equal(json.status, 406);
    assert.equal(await json.text(), "");
    assert.equal((await put(base, "/unpack/all", container, { accept: "text/plain" })).status, 406);
    for (const accept of ["application/zip", "*/*", "application/*", "application/json, application/zip;q=0.5"]) {
      assert.equal((await put(base, "/unpack", container, { accept })).status, 200, accept);
    }
  });
});

test("the routes Tika's /unpack does not have here are not found; a method it does not serve is 405 (r176, r177)", async () => {
  await withServer(async (base) => {
    for (const path of ["/unpack/preset/foo", "/unpack/preset/foo/all", "/unpack/config", "/unpack/all/config", "/unpack/all/text/x", "/unpack/text"]) {
      const response = await put(base, path);
      // /unpack/all/config reads `config` as a handler name, as Tika's {handler} does: a 400.
      assert.equal(response.status, path === "/unpack/all/config" ? 400 : 404, path);
    }
    const get = await fetch(`${base}/unpack`);
    assert.equal(get.status, 405);
  });
});

test("an empty body is 422 with the failure as the body (r168); a document with nothing embedded is a package of the manifests (r167)", async () => {
  await withServer(async (base) => {
    const empty = await put(base, "/unpack", new Uint8Array(0));
    assert.equal(empty.status, 422);
    assert.match(empty.headers.get("content-type") ?? "", /^text\/plain/);
    assert.match(await empty.text(), /^ZeroByteFileError: /);

    const { entries } = await unpacked(await put(base, "/unpack", "just text, nothing inside"));
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["datapackage.json", "rmeta.json"],
    );
  });
});

test("a document inside that cannot be read stays in the package, its failure in its record of rmeta.json (r169)", async () => {
  await withServer(async (base) => {
    const broken = storedZip({ "ok.txt": "fine", "bad.docx": "PK\u0003\u0004 definitely not a zip file" });
    const { manifest, rmeta, entries } = await unpacked(await put(base, "/unpack", broken));
    const bad = rmeta.find((record) => record["tk:resource-name"] === "bad.docx");
    assert.ok(bad !== undefined && Object.keys(bad).some((key) => key.startsWith("tk:exception")), JSON.stringify(bad));
    const resource = manifest.resources.find((candidate) => candidate["tk:resource-name"] === "bad.docx");
    assert.equal(entries.find((entry) => entry.name === resource?.path)?.data.toString("utf8"), "PK\u0003\u0004 definitely not a zip file");
  });
});

test("maxUnpackBytes: a document that would take the total past it is left out of the package and stays in rmeta.json", async () => {
  await withServer(
    async (base) => {
      const zip = storedZip({ "a.txt": "a".repeat(30), "b.txt": "b".repeat(30), "c.txt": "c".repeat(10) });
      const { manifest, rmeta } = await unpacked(await put(base, "/unpack", zip));
      assert.deepEqual(
        manifest.resources.slice(1).map((resource) => resource["tk:resource-name"]),
        ["a.txt", "c.txt"],
        "30 + 30 is past 50; the 10 that still fits is kept",
      );
      assert.equal(rmeta.length, 4, "the container and all three documents");
    },
    { maxUnpackBytes: 50 },
  );
});

test("maxUnpackBytes 0 keeps only the documents that have no bytes", async () => {
  await withServer(
    async (base) => {
      const { manifest } = await unpacked(await put(base, "/unpack", storedZip({ "a.txt": "text", "empty.txt": "" })));
      assert.deepEqual(manifest.resources.slice(1).map((resource) => resource["tk:resource-name"]), ["empty.txt"]);
    },
    { maxUnpackBytes: 0 },
  );
});

test("a client cannot ask for more than maxUnpackBytes: there is no parameter for it", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/unpack?maxUnpackBytes=999999999");
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Unknown query parameter "maxUnpackBytes"/);
  });
});

test("maxUnpackBytes must be a whole number up to 2 GiB", () => {
  for (const maxUnpackBytes of [-1, 1.5, Number.NaN, 2 * 1024 ** 3 + 1]) {
    assert.throws(() => createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, maxUnpackBytes }), RangeError, String(maxUnpackBytes));
  }
  createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, maxUnpackBytes: 2 * 1024 ** 3 });
});

const isolated = (unpackCeiling: number): ServerIsolationStatus => ({
  mode: "strict",
  degraded: false,
  pool: { poolMb: 8192, maxQueue: 4 },
  defaultReservationMb: { text: 1024, records: 2048 },
  limits: { maxOutputChars: 1000, unpackCeiling },
});

test("with an isolation, maxUnpackBytes above what its children may hold is refused when the server is built, naming both", () => {
  const ceiling = 64 * 1024 * 1024;
  const build = (maxUnpackBytes?: number) =>
    createRipstreamServer({
      ripstream: createRipstream(),
      isolation: { status: () => isolated(ceiling) },
      maxLimits: { maxOutputChars: 1000 },
      log: () => undefined,
      ...(maxUnpackBytes === undefined ? {} : { maxUnpackBytes }),
    });
  assert.throws(() => build(ceiling + 1), (error: unknown) => error instanceof RangeError && /67108865/.test(error.message) && /67108864/.test(error.message));
  build(ceiling);
  build(); // the default (100 MiB) is held under the ceiling, not refused
});

test("with an isolation, the default budget is held under what its children may hold", async () => {
  const seen: Array<number | undefined> = [];
  const engine = createRipstream();
  const ripstream = {
    detect: engine.detect.bind(engine),
    parse: engine.parse.bind(engine),
    parseRecursive: (source: Parameters<typeof engine.parseRecursive>[0], options: Parameters<typeof engine.parseRecursive>[1]) => {
      seen.push(options?.unpackBytes);
      return engine.parseRecursive(source, options);
    },
  };
  await withServer(
    async (base) => {
      await unpacked(await put(base, "/unpack"));
    },
    { ripstream, isolation: { status: () => isolated(8 * 1024 * 1024) }, maxLimits: { maxOutputChars: 1000 } },
  );
  assert.deepEqual(seen, [8 * 1024 * 1024]);
});

test("the welcome page lists the unpack routes", async () => {
  await withServer(async (base) => {
    const page = await (await fetch(`${base}/`, { headers: { accept: "text/plain" } })).text();
    assert.match(page, /PUT \/unpack\n/);
    assert.match(page, /PUT \/unpack\/all\[\/\{handler\}\]/);
    assert.match(page, /POST \/unpack\[\/all\[\/\{handler\}\]\] \(multipart\)/);
  });
});
