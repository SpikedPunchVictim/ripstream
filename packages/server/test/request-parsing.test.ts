import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaType, Metadata, type InputSource, type ParseOptions } from "@spikedpunch/ripstream-core";
import { createRipstreamServer, type RipstreamServerOptions, type ServerRipstream } from "../src/index.ts";

/*
 * How a request is read: the names a client gives its document, the boundary of a multipart body, the headers a browser
 * sends first and the limits a preset names. Each is a place where the server read the request differently from the
 * client that wrote it.
 */

interface Seen {
  filename: string | undefined;
  limits: ParseOptions["limits"];
  bytes: Uint8Array | undefined;
}

function recorder(): { readonly engine: ServerRipstream; readonly seen: Seen } {
  const seen: Seen = { filename: undefined, limits: undefined, bytes: undefined };
  const note = (source: InputSource, options: ParseOptions | undefined): void => {
    seen.filename = options?.filename;
    seen.limits = options?.limits;
    seen.bytes = source instanceof Uint8Array ? source : undefined;
  };
  return {
    seen,
    engine: {
      async detect(source, options) {
        note(source, options);
        return MediaType.TEXT_PLAIN;
      },
      async parse(source, options) {
        note(source, options);
        return { metadata: new Metadata(), text: "text" };
      },
      async parseRecursive() {
        return [];
      },
    },
  };
}

async function withServer<T>(options: RipstreamServerOptions, run: (base: string) => Promise<T>): Promise<T> {
  const instance = createRipstreamServer({ log: () => undefined, ...options });
  const port = await instance.listen();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await instance.close();
  }
}

/** A one-part multipart body whose part headers and content are the given bytes. */
function form(boundary: string, partHeaders: Buffer, content: Buffer, closing = true): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    partHeaders,
    Buffer.from("\r\n\r\n"),
    content,
    Buffer.from(`\r\n--${boundary}${closing ? "--" : ""}\r\n`),
  ]);
}

const upload = (base: string, body: Buffer, boundary: string, type = "multipart/form-data"): Promise<Response> =>
  fetch(`${base}/detect`, { method: "PUT", body, headers: { "content-type": `${type}; boundary=${boundary}` } });

test("a multipart file name sent as UTF-8 is read as UTF-8", async () => {
  const { engine, seen } = recorder();
  await withServer({ ripstream: engine }, async (base) => {
    const headers = Buffer.from('Content-Disposition: form-data; name="file"; filename="résumé 日本.txt"', "utf8");
    assert.equal((await upload(base, form("XX", headers, Buffer.from("x")), "XX")).status, 200);
  });
  assert.equal(seen.filename, "résumé 日本.txt");
});

test("a multipart body is split at delimiter lines, not wherever the boundary text appears", async () => {
  const { engine, seen } = recorder();
  await withServer({ ripstream: engine }, async (base) => {
    const headers = Buffer.from('Content-Disposition: form-data; name="file"; filename="a.txt"');
    const content = Buffer.from("before --XX after\r\n--XXtra line\r\nlast");
    assert.equal((await upload(base, form("XX", headers, content), "XX")).status, 200);
  });
  assert.equal(Buffer.from(seen.bytes ?? []).toString(), "before --XX after\r\n--XXtra line\r\nlast");
});

test("a multipart request type is read without regard to case", async () => {
  const { engine, seen } = recorder();
  await withServer({ ripstream: engine }, async (base) => {
    const headers = Buffer.from('Content-Disposition: form-data; name="file"; filename="a.txt"');
    assert.equal((await upload(base, form("XX", headers, Buffer.from("x")), "XX", "Multipart/Form-Data")).status, 200);
  });
  assert.equal(seen.filename, "a.txt");
});

test("a Content-Disposition filename is read as RFC 6266 writes it", async () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['attachment; filename="semi;colon.pdf"', "semi;colon.pdf"],
    ['attachment; filename="a\\"b.pdf"', 'a"b.pdf'],
    ["attachment; FILENAME=plain.txt", "plain.txt"],
    ["attachment; filename = spaced.txt", "spaced.txt"],
    ["attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", "résumé.pdf"],
    ['attachment; filename="fallback.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf', "résumé.pdf"],
    ["attachment; filename*=UTF-8''%E0%E0", undefined],
    ["attachment", undefined],
  ];
  for (const [header, expected] of cases) {
    const { engine, seen } = recorder();
    await withServer({ ripstream: engine }, async (base) => {
      await fetch(`${base}/detect`, { method: "PUT", body: "x", headers: { "content-disposition": header } });
    });
    assert.equal(seen.filename, expected, header);
  }
});

test("a CORS preflight allows the Authorization header the server asks for", async () => {
  await withServer({ ripstream: recorder().engine, corsOrigin: "https://app.example" }, async (base) => {
    const response = await fetch(`${base}/tika`, { method: "OPTIONS" });
    const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/);
    assert.ok(allowed.includes("authorization"), allowed.join(","));
  });
});

test("a preset that sets no limit does not lift the server's ceiling", async () => {
  const { engine, seen } = recorder();
  await withServer(
    { ripstream: engine, maxLimits: { maxOutputChars: 5 }, presets: { open: { limits: { maxOutputChars: -1 } } } },
    async (base) => {
      assert.equal((await fetch(`${base}/tika?preset=open`, { method: "PUT", body: "x" })).status, 200);
    },
  );
  assert.equal(seen.limits?.maxOutputChars, 5);
});

test("a preset below the ceiling keeps its own limit", async () => {
  const { engine, seen } = recorder();
  await withServer(
    { ripstream: engine, maxLimits: { maxOutputChars: 50 }, presets: { short: { limits: { maxOutputChars: 5 } } } },
    async (base) => {
      assert.equal((await fetch(`${base}/tika?preset=short`, { method: "PUT", body: "x" })).status, 200);
    },
  );
  assert.equal(seen.limits?.maxOutputChars, 5);
});

test("an Accept that refuses a type by q=0 refuses it even beside */*", async () => {
  await withServer({ ripstream: recorder().engine }, async (base) => {
    const put = (accept: string): Promise<Response> => fetch(`${base}/tika/text`, { method: "PUT", body: "x", headers: { accept } });
    assert.equal((await put("text/plain;q=0, */*")).status, 406);
    assert.equal((await put("text/*;q=0, */*")).status, 406);
    assert.equal((await put("application/json;q=0, */*")).status, 200);
    assert.equal((await put("*/*;q=0.5, text/plain;q=0.1")).status, 200);
  });
});
