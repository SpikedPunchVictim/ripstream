import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { createRipstream } from "@spikedpunch/ripstream-parsers";
import { createRipstreamServer } from "../src/index.ts";

/*
 * The routes of Tika 4.2.0's server that ripstream serves (tasks/parity/audits/server-inventory.json, U01-U25):
 * /tika/{text,html,xml,md}, /tika/json[/{handler}], /rmeta/{handler}, /meta/{field}, the form routes and the welcome
 * pages. What each answers was read from Tika's source and from its responses saved in
 * tasks/parity/server/differential.json.
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

const TEXT = "Hello server";
const put = (base: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: "PUT", body: TEXT, ...init });
const get = (base: string, path: string, init: RequestInit = {}): Promise<Response> => fetch(`${base}${path}`, init);

const NOT_A_ZIP = new TextEncoder().encode("PK\u0003\u0004 definitely not a zip file");
const asDocx = { "content-disposition": 'attachment; filename="fake.docx"' };
const UNRECOGNIZED = "Unrecognized handler type 'bogus'. Valid types: text, txt, html, xml, body, markdown, md, ignore";

test("/tika/text is the text of the body, as text/plain", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/tika/text");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "Hello server\n");
  });
});

test("/tika/html and /tika/xml are the XHTML the parsers wrote, with the metadata in the head", async () => {
  await withServer(async (base) => {
    const html = await put(base, "/tika/html");
    assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
    const page = await html.text();
    assert.match(page, /^<html>/);
    assert.match(page, /<meta name="Content-Type" content="text\/plain">/);
    assert.match(page, /<p>Hello server<\/p>/);

    const xml = await put(base, "/tika/xml");
    assert.equal(xml.headers.get("content-type"), "text/xml; charset=utf-8");
    // XML closes its empty elements; HTML leaves `meta` open.
    assert.match(await xml.text(), /<meta name="Content-Type" content="text\/plain"><\/meta>/);
  });
});

test("/tika/md is the document as Markdown, as text/plain", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/tika/md");
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "Hello server\n");
  });
});

test("a trailing slash names the same route", async () => {
  await withServer(async (base) => {
    assert.equal(await (await put(base, "/tika/")).text(), "Hello server\n");
    assert.match(await (await put(base, "/tika/html/")).text(), /^<html>/);
    assert.equal(((await (await put(base, "/meta/")).json()) as Record<string, string>)["Content-Type"], "text/plain");
  });
});

test("/tika/json is one object: the metadata, the content in tk:content and the handler that made it", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/tika/json");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    const object = (await response.json()) as Record<string, unknown>;
    assert.equal(object["Content-Type"], "text/plain");
    assert.equal(object["tk:content"], "Hello server\n");
    assert.equal(object["tk:content-handler-type"], "TEXT");
  });
});

test("/tika/json/{handler} writes the content in that shape; ignore has none, and says so", async () => {
  await withServer(async (base) => {
    const html = (await (await put(base, "/tika/json/html")).json()) as Record<string, unknown>;
    assert.match(String(html["tk:content"]), /^<html>/);
    assert.equal(html["tk:content-handler-type"], "HTML");

    const markdown = (await (await put(base, "/tika/json/md")).json()) as Record<string, unknown>;
    assert.equal(markdown["tk:content"], "Hello server\n");
    assert.equal(markdown["tk:content-handler-type"], "MARKDOWN");

    const ignored = (await (await put(base, "/tika/json/ignore")).json()) as Record<string, unknown>;
    assert.equal(ignored["tk:content"], undefined);
    assert.equal(ignored["tk:content-handler-type"], "IGNORE");
    assert.equal(ignored["Content-Type"], "text/plain");
  });
});

test("a handler Tika does not know is a 400 with Tika's message, before the document is read", async () => {
  await withServer(async (base) => {
    for (const path of ["/tika/json/bogus", "/rmeta/bogus", "/rmeta/form/bogus"]) {
      const response = await put(base, path, { method: "POST" });
      assert.equal(response.status, 400, path);
      assert.equal(await response.text(), UNRECOGNIZED, path);
    }
  });
});

test("/rmeta/{handler}: each document's content in that shape, the handler named in each record", async () => {
  await withServer(async (base) => {
    const records = async (path: string): Promise<Array<Record<string, unknown>>> =>
      (await (await put(base, path)).json()) as Array<Record<string, unknown>>;

    const [html] = await records("/rmeta/html");
    assert.match(String(html?.["tk:content"]), /^<html>/);
    assert.equal(html?.["tk:content-handler-type"], "HTML");

    const [markdown] = await records("/rmeta/md");
    assert.equal(markdown?.["tk:content"], "Hello server\n");
    assert.equal(markdown?.["tk:content-handler-type"], "MARKDOWN");

    const [body] = await records("/rmeta/body");
    assert.equal(body?.["tk:content-handler-type"], "BODY");

    const [ignored] = await records("/rmeta/ignore");
    assert.equal(ignored?.["tk:content"], undefined);
    assert.equal(ignored?.["tk:content-handler-type"], undefined);
    assert.equal(ignored?.["Content-Type"], "text/plain");

    const [bare] = await records("/rmeta");
    assert.equal(bare?.["tk:content-handler-type"], "TEXT");
  });
});

test("/rmeta/ignore has no output limit: it writes no content, so none can be reached", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/rmeta/ignore?maxOutputChars=1");
    assert.equal(response.status, 200);
    const [record] = (await response.json()) as Array<Record<string, unknown>>;
    assert.equal(record?.["tk:exception:write-limit-reached"], undefined);
  }, { onOutputLimit: "throw" });
});

test("/tika?handler= takes Tika's spellings, in any case, and a preset can name one", async () => {
  await withServer(
    async (base) => {
      const html = await put(base, "/tika?handler=HTML");
      assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(await html.text(), /^<html>/);
      assert.equal(await (await put(base, "/tika?handler=md")).text(), "Hello server\n");
      assert.equal(await (await put(base, "/tika?handler=ignore")).text(), "");
      assert.match(await (await put(base, "/tika?preset=page")).text(), /^<html>/);
      // ?handler= is the more specific of the two.
      assert.equal(await (await put(base, "/tika?preset=page&handler=txt")).text(), "Hello server\n");
    },
    { presets: { page: { handler: "html" } } },
  );
});

test("a route that fixes its handler refuses ?handler=", async () => {
  await withServer(async (base) => {
    for (const path of ["/tika/text?handler=html", "/tika/json?handler=html"]) {
      const response = await put(base, path);
      assert.equal(response.status, 400, path);
      assert.match(await response.text(), /names its handler in the path/, path);
    }
  });
});

test("/tika/json carries a failure in the object (200); /tika/html answers 422 with the failure in a header", async () => {
  await withServer(async (base) => {
    const json = await put(base, "/tika/json", { body: NOT_A_ZIP, headers: asDocx });
    assert.equal(json.status, 200);
    const object = (await json.json()) as Record<string, unknown>;
    assert.match(String(object["tk:exception:container-exception"]), /^MalformedDocumentError: /);
    assert.equal(object["tk:content-handler-type"], "TEXT");

    const html = await put(base, "/tika/html", { body: NOT_A_ZIP, headers: asDocx });
    assert.equal(html.status, 422);
    assert.match(html.headers.get("x-ripstream-error") ?? "", /^MalformedDocumentError: /);
  });
});

test("/meta/{field}: the one field, as JSON, CSV or plain text by Accept", async () => {
  await withServer(async (base) => {
    const json = await put(base, "/meta/Content-Type");
    assert.equal(json.headers.get("content-type"), "application/json");
    assert.deepEqual(await json.json(), { "Content-Type": "text/plain" });

    const csv = await put(base, "/meta/Content-Type", { headers: { accept: "text/csv" } });
    assert.equal(csv.headers.get("content-type"), "text/csv; charset=UTF-8");
    assert.equal(await csv.text(), "Content-Type,text/plain\r\n");

    const plain = await put(base, "/meta/Content-Type", { headers: { accept: "text/plain" } });
    assert.equal(plain.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await plain.text(), "text/plain");
  });
});

test("/meta/{field}: a field the document does not have is 404, an Accept it cannot meet is 406", async () => {
  await withServer(async (base) => {
    const missing = await put(base, "/meta/no-such-field");
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Failed to get metadata field no-such-field");

    assert.equal((await put(base, "/meta/Content-Type", { headers: { accept: "image/png" } })).status, 406);
  });
});

test("/meta/{field} of a document that could not be read is 422: a bare value has no envelope to carry the failure", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/meta/Content-Type", { body: NOT_A_ZIP, headers: asDocx });
    assert.equal(response.status, 422);
    assert.match(await response.text(), /^MalformedDocumentError: /);
  });
});

test("/meta: JSON by default, CSV when asked for, 406 for what it cannot write", async () => {
  await withServer(async (base) => {
    const json = await put(base, "/meta", { headers: { accept: "application/json" } });
    assert.equal(((await json.json()) as Record<string, string>)["Content-Type"], "text/plain");

    const csv = await put(base, "/meta", { headers: { accept: "text/csv" } });
    assert.equal(csv.headers.get("content-type"), "text/csv; charset=UTF-8");
    const rows = (await csv.text()).split("\r\n");
    assert.ok(rows.includes("Content-Type,text/plain"));
    assert.equal(rows.at(-1), "", "every row ends in CRLF");

    // Tika answers application/rdf+xml with XMP; this server does not write XMP.
    assert.equal((await put(base, "/meta", { headers: { accept: "application/rdf+xml" } })).status, 406);
  });
});

test("/meta is metadata only: it writes no content, so it has no output limit to reach", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/meta?maxOutputChars=1");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Record<string, string>)["Content-Type"], "text/plain");
  }, { onOutputLimit: "throw" });
});

test("the form routes take a POSTed multipart form, and nothing else", async () => {
  await withServer(async (base) => {
    const form = (): FormData => {
      const data = new FormData();
      data.append("file", new Blob(["Multipart text"], { type: "text/plain" }), "upload.txt");
      return data;
    };
    const meta = await fetch(`${base}/meta/form`, { method: "POST", body: form() });
    assert.equal(meta.status, 200);
    assert.equal(((await meta.json()) as Record<string, string>)["Content-Type"], "text/plain");

    const rmeta = await fetch(`${base}/rmeta/form`, { method: "POST", body: form() });
    assert.match(String((await rmeta.json() as Array<Record<string, unknown>>)[0]?.["tk:content"]), /Multipart text/);

    const html = await fetch(`${base}/rmeta/form/html`, { method: "POST", body: form() });
    assert.equal(((await html.json()) as Array<Record<string, unknown>>)[0]?.["tk:content-handler-type"], "HTML");

    const notMultipart = await fetch(`${base}/meta/form`, { method: "POST", body: TEXT });
    assert.equal(notMultipart.status, 415);

    const put = await fetch(`${base}/meta/form`, { method: "PUT", body: form() });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get("allow"), "POST");
  });
});

test("GET / is a welcome page, HTML or text by Accept, and HEAD answers the same without the body", async () => {
  await withServer(async (base) => {
    const html = await get(base, "/");
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
    const page = await html.text();
    assert.match(page, /<title>Ripstream<\/title>/);
    assert.match(page, /PUT \/tika\/\{text,html,xml,md\}/);

    const text = await get(base, "/", { headers: { accept: "text/plain" } });
    assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(await text.text(), /^Ripstream 0\.0\.0\n\nPUT \/tika\n/);

    const head = await get(base, "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await head.text(), "");

    assert.equal((await get(base, "/", { headers: { accept: "application/json" } })).status, 406);
  });
});

test("the welcome page lists the routes this server serves, and only those", async () => {
  await withServer(
    async (base) => {
      const text = await (await get(base, "/", { headers: { accept: "text/plain" } })).text();
      assert.match(text, /PUT \/detect/);
      assert.doesNotMatch(text, /\/tika|\/rmeta|\/meta/);
    },
    { endpoints: ["detect", "version"] },
  );
});

test("GET /tika is Tika's greeting, in this server's name", async () => {
  await withServer(async (base) => {
    const response = await get(base, "/tika");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "This is Ripstream Server (ripstream 0.0.0). Please PUT\n");
  });
});

test("the new routes follow the endpoints option: a disabled /tika takes its whole family with it", async () => {
  await withServer(
    async (base) => {
      for (const path of ["/tika/html", "/tika/json", "/rmeta/html", "/meta/Content-Type"]) {
        assert.equal((await put(base, path)).status, 404, path);
      }
      assert.equal((await put(base, "/detect")).status, 200);
    },
    { endpoints: ["detect"] },
  );
});

test("paths that are no route: an extra segment, an unknown format, a field with a path under it", async () => {
  await withServer(async (base) => {
    for (const path of ["/tika/nope", "/tika/text/extra", "/tika/json/html/extra", "/rmeta/html/extra", "/meta/a/b", "/detect/x", "/tika/%E0%A4%A"]) {
      assert.equal((await put(base, path)).status, 404, path);
    }
  });
});

const MIME_TYPES = [
  { type: "text/plain", aliases: [], extensions: [".txt", ".text"], description: "Plain text", parser: "TextParser" },
  { type: "application/gzip", aliases: ["application/x-gzip"], supertype: "application/octet-stream", extensions: [".gz"] },
  { type: "application/octet-stream" },
];

test("/mime-types is HTML by default, JSON or text when asked, the types in order by name", async () => {
  await withServer(
    async (base) => {
      const html = await get(base, "/mime-types");
      assert.equal(html.status, 200);
      assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
      const page = await html.text();
      assert.match(page, /<h2><a href="\/mime-types\/application\/gzip">application\/gzip<\/a><\/h2>/);
      assert.match(page, /<div>Alias: application\/x-gzip<\/div>/);
      assert.ok(page.indexOf("application/gzip") < page.indexOf("text/plain"));

      const json = await get(base, "/mime-types", { headers: { accept: "application/json" } });
      assert.equal(json.headers.get("content-type"), "application/json");
      const types = (await json.json()) as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(types), ["application/gzip", "application/octet-stream", "text/plain"]);
      assert.deepEqual(types["application/gzip"], { alias: ["application/x-gzip"], supertype: "application/octet-stream" });
      assert.deepEqual(types["text/plain"], { alias: [], parser: "TextParser" });

      const text = await get(base, "/mime-types", { headers: { accept: "text/plain" } });
      assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(
        await text.text(),
        "application/gzip\n  alias:     application/x-gzip\n  supertype: application/octet-stream\napplication/octet-stream\ntext/plain\n  parser:    TextParser\n",
      );

      assert.equal((await get(base, "/mime-types", { headers: { accept: "image/png" } })).status, 406);
    },
    { mimeTypes: MIME_TYPES },
  );
});

test("/mime-types/{type}/{subtype} describes one type, found by its name in any case", async () => {
  await withServer(
    async (base) => {
      const json = await get(base, "/mime-types/text/plain", { headers: { accept: "application/json" } });
      assert.deepEqual(await json.json(), {
        type: "text/plain",
        alias: [],
        parser: "TextParser",
        description: "Plain text",
        defaultExtension: ".txt",
        extensions: [".txt", ".text"],
      });
      assert.deepEqual(
        await (await get(base, "/mime-types/APPLICATION/Gzip/", { headers: { accept: "application/json" } })).json(),
        { type: "application/gzip", alias: ["application/x-gzip"], supertype: "application/octet-stream", defaultExtension: ".gz", extensions: [".gz"] },
      );

      const html = await (await get(base, "/mime-types/text/plain")).text();
      assert.match(html, /<h2>text\/plain<\/h2>/);
      assert.match(html, /<div>Default Extension: \.txt<\/div>/);
      assert.match(html, /<div>Parser: TextParser<\/div>/);

      // A single type has no plain-text form in Tika, and none here.
      assert.equal((await get(base, "/mime-types/text/plain", { headers: { accept: "text/plain" } })).status, 406);
    },
    { mimeTypes: MIME_TYPES },
  );
});

test("/mime-types: a type nobody registered is 404, a path with another shape is 404, anything but GET is 405", async () => {
  await withServer(
    async (base) => {
      assert.equal((await get(base, "/mime-types/no/such")).status, 404);
      assert.equal((await get(base, "/mime-types/text")).status, 404);
      assert.equal((await get(base, "/mime-types/text/plain/extra")).status, 404);
      const post = await get(base, "/mime-types", { method: "POST", body: TEXT });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("allow"), "GET, HEAD");
      const stray = await get(base, "/mime-types?x=1");
      assert.equal(stray.status, 400);
    },
    { mimeTypes: MIME_TYPES },
  );
});

test("/mime-types: a server that was given no registry says so with a 404, and a disabled endpoint is 404 too", async () => {
  await withServer(async (base) => {
    const none = await get(base, "/mime-types");
    assert.equal(none.status, 404);
    assert.match(await none.text(), /no media type registry/);
  });
  await withServer(async (base) => assert.equal((await get(base, "/mime-types")).status, 404), {
    mimeTypes: MIME_TYPES,
    endpoints: ["detect"],
  });
});

test("the welcome page lists /mime-types with the other routes", async () => {
  await withServer(async (base) => {
    assert.match(await (await get(base, "/", { headers: { accept: "text/plain" } })).text(), /GET \/mime-types\/\{type\}\/\{subtype\}/);
  });
});

/*
 * /language and Accept. Tika's /language answers the bare two-letter code as text/plain; ripstream adds the detector's
 * whole answer for `Accept: application/json`, where Tika answers 406.
 */

const ENGLISH =
  "The parser extracts text and metadata from documents, and the test suite verifies that each format is handled correctly.";

test("/language answers the two-letter code as text/plain, with no newline", async () => {
  await withServer(async (base) => {
    for (const method of ["PUT", "POST"]) {
      const response = await put(base, "/language", { method, body: ENGLISH });
      assert.equal(response.status, 200, method);
      assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
      assert.equal(await response.text(), "en", method);
    }
    const french = await put(base, "/language", { body: "Ceci est une phrase française sur les documents et leurs métadonnées." });
    assert.equal(await french.text(), "fr");
  });
});

test("/language of a body too short to tell is an empty 200, as Tika's is for an empty one", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/language", { body: "" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  });
});

test("/language: Accept application/json is the detector's whole answer; what it cannot write is 406", async () => {
  await withServer(async (base) => {
    const json = await put(base, "/language", { body: ENGLISH, headers: { accept: "application/json" } });
    assert.equal(json.status, 200);
    assert.deepEqual(await json.json(), { language: "eng", confidence: 0.9, isReasonablyCertain: true });
    const refused = await put(base, "/language", { body: ENGLISH, headers: { accept: "image/png" } });
    assert.equal(refused.status, 406);
    assert.equal(await refused.text(), "");
  });
});

test("/language looks at the first 100,000 characters and ignores the rest", async () => {
  await withServer(async (base) => {
    const response = await put(base, "/language", { body: `${ENGLISH} `.repeat(3000) });
    assert.equal(await response.text(), "en");
  });
});

test("a route answers 406, with no body, for an Accept it cannot meet: what it writes is all it offers", async () => {
  await withServer(async (base) => {
    const json = { accept: "application/json" };
    const cases: Array<readonly [string, string, string]> = [
      ["PUT", "/tika", "application/json"],
      ["PUT", "/tika/text", "application/json"],
      ["PUT", "/tika/md", "application/json"],
      ["PUT", "/tika/html", "text/plain"],
      ["PUT", "/tika/xml", "text/html"],
      ["PUT", "/tika/json", "text/plain"],
      ["PUT", "/rmeta", "text/plain"],
      ["PUT", "/meta", "text/plain"],
      ["PUT", "/detect", "application/json"],
      ["GET", "/version", "application/json"],
      ["GET", "/tika", "application/json"],
    ];
    for (const [method, path, accept] of cases) {
      const response = await fetch(`${base}${path}`, { method, body: method === "PUT" ? TEXT : undefined, headers: { accept } });
      assert.equal(response.status, 406, `${method} ${path} ${accept}`);
      assert.equal(await response.text(), "", `${method} ${path}`);
    }
    assert.equal((await put(base, "/tika", { headers: json })).status, 406);
  });
});

test("Accept is read as a list: a range, a q-weighted choice and */* all meet a route that writes one type", async () => {
  await withServer(async (base) => {
    for (const accept of ["*/*", "text/*", "text/plain", "application/json;q=0.5, text/plain", "image/png, */*;q=0.1"]) {
      assert.equal((await put(base, "/tika/text", { headers: { accept } })).status, 200, accept);
    }
    assert.equal((await put(base, "/tika/text", { headers: { accept: "text/plain;q=0" } })).status, 406);
  });
});

test("the Accept check comes before the document is read: an unreadable one is still a 406", async () => {
  await withServer(async (base) => {
    const refused = await put(base, "/tika", { body: NOT_A_ZIP, headers: { ...asDocx, accept: "application/json" } });
    assert.equal(refused.status, 406);
    const empty = await put(base, "/rmeta", { body: "", headers: { accept: "text/plain" } });
    assert.equal(empty.status, 406);
  });
});

test("?handler=json is ripstream's older object, and it offers application/json, not text", async () => {
  await withServer(async (base) => {
    assert.equal((await put(base, "/tika?handler=json", { headers: { accept: "application/json" } })).status, 200);
    assert.equal((await put(base, "/tika?handler=json", { headers: { accept: "text/plain" } })).status, 406);
    assert.equal((await put(base, "/tika?handler=html", { headers: { accept: "text/html" } })).status, 200);
    assert.equal((await put(base, "/tika?handler=html", { headers: { accept: "text/plain" } })).status, 406);
  });
});

/*
 * The request line and the method matrix: what Tika's server (Jersey on Jetty) does with a trailing slash, dot
 * segments, `//`, HEAD and OPTIONS (server-inventory X14, X15), and gzip in both directions (X12).
 */

test("a trailing slash is ignored on every route", async () => {
  await withServer(async (base) => {
    assert.equal(await (await get(base, "/version/")).text(), "ripstream 0.0.0\n");
    assert.equal((await put(base, "/tika/")).status, 200);
    assert.equal((await put(base, "/rmeta/")).status, 200);
    assert.equal((await put(base, "/tika/text/")).status, 200);
    assert.equal((await put(base, "/language/", { body: ENGLISH })).status, 200);
    assert.equal((await get(base, "/mime-types/")).status, 200);
  }, { mimeTypes: [{ type: "text/plain" }] });
});

test("dot segments are not folded: /tika/../version is a 404, and so is the encoded form", async () => {
  await withServer(async (base) => {
    // fetch folds dots itself, so these go out as the raw request target.
    for (const target of ["/tika/../version", "/tika/./text", "/%2e%2e/version", "/tika/%2E%2E/version"]) {
      assert.equal(await rawStatus(base, "GET", target), 404, target);
    }
  });
});

test("a request target that starts with // is a 400, not a host", async () => {
  await withServer(async (base) => {
    assert.equal(await rawStatus(base, "PUT", "//tika/text"), 400);
    assert.equal(await rawStatus(base, "GET", "//version"), 400);
  });
});

test("HEAD is the GET's headers without its body, on every route that has a GET", async () => {
  await withServer(async (base) => {
    for (const path of ["/", "/version", "/tika", "/health", "/mime-types", "/mime-types/text/plain"]) {
      const head = await get(base, path, { method: "HEAD" });
      const full = await get(base, path);
      assert.equal(head.status, 200, path);
      assert.equal(head.headers.get("content-type"), full.headers.get("content-type"), path);
      assert.equal(await head.text(), "", path);
    }
    // A route with no GET has no HEAD either, and the root takes nothing else.
    assert.equal((await get(base, "/detect", { method: "HEAD" })).status, 405);
    const root = await put(base, "/");
    assert.equal(root.status, 405);
    assert.equal(root.headers.get("allow"), "GET, HEAD");
  }, { mimeTypes: [{ type: "text/plain" }] });
});

test("OPTIONS is a 200 with Tika's Allow list and no body, on any path", async () => {
  await withServer(async (base) => {
    for (const path of ["/", "/tika", "/rmeta", "/no/such/route"]) {
      const response = await get(base, path, { method: "OPTIONS" });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("allow"), "POST, GET, PUT, OPTIONS, HEAD", path);
      assert.equal(await response.text(), "", path);
    }
  });
});

test("a response of text, JSON or XML is gzipped for a client that allows it, and left alone for one that does not", async () => {
  await withServer(async (base) => {
    const long = "lorem ipsum dolor sit amet ".repeat(200);
    const plain = await put(base, "/tika/text", { body: long, headers: { "accept-encoding": "identity" } });
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal((await plain.text()).trim(), long.trim());

    // fetch inflates what it is sent; the raw bytes are read over a socket.
    const raw = await rawRequest(base, "PUT", "/tika/text", { "accept-encoding": "gzip" }, long);
    assert.equal(raw.headers["content-encoding"], "gzip");
    assert.equal(raw.headers.vary, "Accept-Encoding");
    assert.equal(gunzipSync(raw.body).toString().trim(), long.trim());
    assert.ok(raw.body.length < long.length / 4, "it is smaller on the wire");

    // Too small to be worth it, a type that is not text, and gzip refused by quality 0.
    const tiny = await rawRequest(base, "GET", "/version", { "accept-encoding": "gzip" });
    assert.equal(tiny.headers["content-encoding"], undefined);
    const refused = await rawRequest(base, "PUT", "/tika/text", { "accept-encoding": "gzip;q=0" }, long);
    assert.equal(refused.headers["content-encoding"], undefined);
    const star = await rawRequest(base, "PUT", "/tika/text", { "accept-encoding": "*" }, long);
    assert.equal(star.headers["content-encoding"], "gzip");
  });
});

test("a request body sent with Content-Encoding: gzip is inflated before it is read", async () => {
  await withServer(async (base) => {
    const body = gzipSync(Buffer.from("A PDF would go here, but plain text will do for the check.\n"));
    const detected = await put(base, "/detect", { body, headers: { "content-encoding": "gzip" } });
    assert.equal(await detected.text(), "text/plain\n", "the document is the text, not a gzip file");
    // Without the header the same bytes are what they look like.
    assert.notEqual(await (await put(base, "/detect", { body })).text(), "text/plain\n");
    const text = await put(base, "/tika/text", { body, headers: { "content-encoding": "gzip" } });
    assert.match(await text.text(), /plain text will do/);
  });
});

test("a gzip request body that is not gzip is a 400, and one that inflates past the cap is a 413", async () => {
  await withServer(
    async (base) => {
      const bad = await put(base, "/tika/text", { body: "not gzip at all", headers: { "content-encoding": "gzip" } });
      assert.equal(bad.status, 400);
      assert.match(await bad.text(), /not valid gzip/);
      // 64 KiB of zeros is a few dozen bytes on the wire: under the cap there, over it inflated.
      const bomb = gzipSync(Buffer.alloc(64 * 1024));
      assert.ok(bomb.length < 1024);
      const refused = await put(base, "/tika/text", { body: bomb, headers: { "content-encoding": "gzip" } });
      assert.equal(refused.status, 413);
      assert.match(await refused.text(), /once decoded/);
      // An empty body is an empty document (422), not a bad gzip.
      const empty = await put(base, "/tika/text", { body: "", headers: { "content-encoding": "gzip" } });
      assert.equal(empty.status, 422);
    },
    { maxBodyBytes: 4096 },
  );
});

/** A request with its target sent exactly as given, and what came back raw (a client would fold dots, or inflate). */
function rawRequest(
  base: string,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
const rawStatus = async (base: string, method: string, target: string): Promise<number> => (await rawRequest(base, method, target)).status;
