import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { MediaType, RIPSTREAM_VERSION, Ripstream, XHTMLContentHandler, type Detector, type Parser } from "../src/index.ts";

const packages = new URL("../../", import.meta.url);

test("RIPSTREAM_VERSION equals the version of every workspace package", () => {
  for (const dir of readdirSync(packages)) {
    const json = JSON.parse(readFileSync(new URL(`${dir}/package.json`, packages), "utf8")) as { version: string };
    assert.equal(json.version, RIPSTREAM_VERSION, `packages/${dir}/package.json`);
  }
});

test("a result carries tk:extractor-version", async () => {
  const detector: Detector = { async detect() { return MediaType.TEXT_PLAIN; } };
  const parser: Parser = { getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]), async parse() {} };
  const result = await new Ripstream({ detector, parser }).parse(new TextEncoder().encode("x"));
  assert.equal(result.metadata.get("tk:extractor-version"), RIPSTREAM_VERSION);
});

test("the container's record carries it too, and it adds nothing to the record's content", async () => {
  const detector: Detector = { async detect() { return MediaType.TEXT_PLAIN; } };
  const parser: Parser = {
    getSupportedTypes: () => new Set([MediaType.TEXT_PLAIN]),
    async parse(_stream, handler, metadata) {
      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();
      await xhtml.element("p", "ok");
      await xhtml.endDocument();
    },
  };
  const [root] = await new Ripstream({ detector, parser }).parseRecursive(new TextEncoder().encode("x"));
  assert.equal(root?.metadata.get("tk:extractor-version"), RIPSTREAM_VERSION);
  assert.equal(root?.content.trim(), "ok");
  assert.equal(root?.content, "\n\n\n\nok\n"); // html, head, title and the body: no meta line, as the key is set after the parse
});
