import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream, TextContentHandler } from "@spikedpunch/ripstream-core";
import { RegexCaptureParser, XMLProfiler } from "../src/index.ts";

const encoder = new TextEncoder();

async function parseWith(parser: { parse: (...args: any[]) => Promise<any> }, text: string) {
  const stream = await RipstreamInputStream.from(encoder.encode(text));
  const handler = new TextContentHandler();
  const metadata = new Metadata();
  await parser.parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  return { metadata, text: handler.toString() };
}

test("RegexCaptureParser captures group 1 per line, sets matched keys and can write content", async () => {
  const parser = new RegexCaptureParser({
    captureMap: { "captured:user": "^user=(.+)$" },
    matchMap: { "captured:admin": "^role=admin$" },
    writeContent: true,
  });
  const { metadata, text } = await parseWith(parser, "user=bob\nrole=admin\nuser=ada\n");
  assert.deepEqual(metadata.getAll("captured:user"), ["bob", "ada"]);
  assert.equal(metadata.get("captured:admin"), "true");
  assert.match(text, /user=bob/);
});

test("XMLProfiler records the root entity and the namespace/local-name profile", async () => {
  const { metadata } = await parseWith(
    new XMLProfiler(),
    '<root xmlns="urn:a"><x/><y><z/></y></root>',
  );
  assert.equal(metadata.get("xmlprofiler:root-entity"), "root");
  assert.deepEqual(metadata.getAll("xmlprofiler:entity-uris"), ["urn:a"]);
  assert.deepEqual(metadata.getAll("xmlprofiler:entity-local-names"), ["root x y z"]);
});
