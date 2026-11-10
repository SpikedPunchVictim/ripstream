import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer } from "../src/index.ts";

/*
 * What a request can set is a closed list. A query parameter, an `X-Tika-*` header, a multipart part or a /pipes key
 * the server does not act on used to be dropped with a 200 (tasks/parity/audits/config-inventory.json: S02, S04, S07,
 * S10), so a client that believed it had set a limit, a handler, a preset or a parse context got the default without
 * a word. Each is now a 400 that names it.
 */

async function withServer<T>(
  run: (base: string) => Promise<T>,
  options: Parameters<typeof createRipstreamServer>[0] = {},
): Promise<T> {
  const instance = createRipstreamServer({ ripstream: createRipstream(), log: () => undefined, ...options });
  const port = await instance.listen();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await instance.close();
  }
}

const TEXT = new TextEncoder().encode("Hello server");
const put = (base: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: "PUT", body: TEXT, ...init });

async function refused(response: Response, pattern: RegExp): Promise<void> {
  const body = await response.text();
  assert.equal(response.status, 400, body);
  assert.match(body, pattern);
}

test("a query parameter the route does not read is refused by name", async () => {
  await withServer(async (base) => {
    for (const path of ["/detect", "/tika", "/meta", "/rmeta", "/unpack"]) {
      await refused(await put(base, `${path}?bogus=1`), /Unknown query parameter "bogus"/);
    }
    await refused(await fetch(`${base}/async?bogus=1`, { method: "POST", body: TEXT }), /Unknown query parameter "bogus"/);
    await refused(await fetch(`${base}/language?bogus=1`, { method: "PUT", body: TEXT }), /Unknown query parameter "bogus"/);
    await refused(await fetch(`${base}/translate?bogus=1`, { method: "PUT", body: TEXT }), /Unknown query parameter "bogus"/);
    await refused(await put(base, "/detect?filename=a.txt&filename=b.txt"), /"filename" was given more than once/);
    // A parameter another route reads is still unknown here.
    await refused(await put(base, "/detect?maxOutputChars=5"), /Unknown query parameter "maxOutputChars"/);
    await refused(await put(base, "/meta?handler=json"), /Unknown query parameter "handler"/);
    await refused(await put(base, "/rmeta?handler=json"), /Unknown query parameter "handler"/);
  });
});

test("the parameters a route reads still work", async () => {
  await withServer(async (base) => {
    assert.equal((await put(base, "/detect?filename=a.txt")).status, 200);
    assert.equal((await put(base, "/tika?filename=a.txt&handler=json&maxOutputChars=100&maxEmbeddedResources=5")).status, 200);
    assert.equal((await put(base, "/meta?filename=a.txt&maxOutputChars=100")).status, 200);
    assert.equal((await put(base, "/rmeta?filename=a.txt&maxEmbeddedResources=5")).status, 200);
    assert.equal((await put(base, "/unpack?filename=a.txt")).status, 200);
  });
});

test("a header that Tika reads and this server does not is refused, not ignored", async () => {
  await withServer(async (base) => {
    await refused(await put(base, "/tika", { headers: { "X-Tika-Skip-Embedded": "true" } }), /X-Tika-Skip-Embedded/i);
    await refused(await put(base, "/rmeta", { headers: { "x-tika-ocrlanguage": "eng" } }), /x-tika-ocrlanguage/i);
    await refused(await put(base, "/detect", { headers: { "X-Tika-PDFsortByPosition": "true" } }), /X-Tika-PDFsortByPosition/i);
    assert.equal((await put(base, "/tika", { headers: { "Content-Type": "text/plain", Accept: "text/plain" } })).status, 200);
  });
});

test("an unknown ?handler= is refused with the handlers there are", async () => {
  await withServer(async (base) => {
    await refused(await put(base, "/tika?handler=xml"), /Unknown handler "xml".*meta, json/);
    await refused(await put(base, "/tika?handler="), /Unknown handler ""/);
    assert.equal((await put(base, "/tika?handler=meta")).status, 200);
    assert.equal((await put(base, "/tika?handler=json")).status, 200);
  });
});

test("an unknown ?preset= is refused, including names that exist on every object", async () => {
  await withServer(
    async (base) => {
      for (const name of ["nope", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
        await refused(await put(base, `/tika?preset=${name}`), /Unknown preset/);
      }
      assert.equal((await put(base, "/tika?preset=short")).status, 200);
    },
    { presets: { short: { limits: { maxOutputChars: 100 } } } },
  );
});

test("a preset with a limit or handler the server cannot apply is refused when the server is built", () => {
  const make = (presets: unknown) => () =>
    createRipstreamServer({ ripstream: createRipstream(), presets: presets as never, log: () => undefined });
  assert.throws(make({ p: { limits: { maxNodeDepth: Number.NaN } } }), /preset "p".*maxNodeDepth/);
  assert.throws(make({ p: { limits: { bogus: 1 } } }), /preset "p".*unknown limit "bogus"/);
  assert.throws(make({ p: { handler: "xml" } }), /preset "p".*handler.*meta, json/);
  make({ p: { handler: "json", limits: { maxOutputChars: 5 } } })();
});

function multipart(parts: ReadonlyArray<{ name: string; filename?: string; body: string }>): { body: Uint8Array; type: string } {
  const boundary = "----ripstream-test";
  const text =
    parts
      .map(
        (part) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${
            part.filename === undefined ? "" : `; filename="${part.filename}"`
          }\r\n\r\n${part.body}\r\n`,
      )
      .join("") + `--${boundary}--\r\n`;
  return { body: new TextEncoder().encode(text), type: `multipart/form-data; boundary=${boundary}` };
}

test("a multipart part other than the one file is refused: a parse context cannot be sent per request", async () => {
  await withServer(async (base) => {
    const upload = (parts: Parameters<typeof multipart>[0]) => {
      const { body, type } = multipart(parts);
      return put(base, "/tika", { body, headers: { "content-type": type } });
    };
    await refused(
      await upload([
        { name: "config", body: '{"parse-context":{}}' },
        { name: "file", filename: "a.txt", body: "Multipart text" },
      ]),
      /multipart part "config" is not supported/,
    );
    await refused(
      await upload([
        { name: "file", filename: "a.txt", body: "one" },
        { name: "extra", body: "x" },
      ]),
      /multipart part "extra" is not supported/,
    );
    await refused(
      await upload([
        { name: "a", filename: "a.txt", body: "one" },
        { name: "b", filename: "b.txt", body: "two" },
      ]),
      /only one file part/,
    );
    const ok = await upload([{ name: "file", filename: "a.txt", body: "Multipart text" }]);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Multipart text/);
  });
});

test("/pipes refuses what it would otherwise ignore or coerce", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "ripstream-pipes-validate-"));
  writeFileSync(join(root, "a.txt"), "a");
  try {
    await withServer(
      async (base) => {
        const post = (body: unknown): Promise<Response> =>
          fetch(`${base}/pipes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const source = { type: "filesystem" };
        await refused(await post({ source, concurency: 4 }), /unknown key "concurency"/);
        await refused(await post({ source, mode: "BOGUS" }), /mode must be one of/);
        await refused(await post({ source, mode: "rmeta" }), /mode must be one of/);
        await refused(await post({ source, ordered: "yes" }), /ordered must be a boolean/);
        await refused(await post({ source, concurrency: "4" }), /concurrency must be a positive integer/);
        await refused(await post({ source, maxQueue: 0 }), /maxQueue must be a positive integer/);
        await refused(await post({ source: { type: "filesystem", paht: "x" } }), /unknown key "paht" in source/);
        await refused(await post({ source: { type: "s3" } }), /source\.type must be "filesystem" or "http"/);
        await refused(await post({ source, followSymlinks: true }), /followSymlinks cannot be set by a client/);
        await refused(await post({ source, sink: { type: "s3", path: "o" } }), /sink\.type must be "filesystem"/);
        await refused(await post({}), /source is required/);
        const ok = await post({ source, mode: "NO_PARSE", ordered: true, concurrency: 2, followSymlinks: false });
        assert.equal(ok.status, 200);
      },
      { authenticate: () => true, pipes: { sourceRoot: root } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
