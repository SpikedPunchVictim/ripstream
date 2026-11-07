import assert from "node:assert/strict";
import { test } from "node:test";
import { MarkdownContentHandler } from "@spikedpunch/ripstream-core";
import { createRipstream } from "../src/index.ts";

const encoder = new TextEncoder();

async function renderHtml(html: string): Promise<string> {
  const ripstream = createRipstream();
  const handler = new MarkdownContentHandler();
  await ripstream.parseToHandler(encoder.encode(html), handler, { filename: "page.html" });
  return handler.toString();
}

test("renders headings, emphasis, and links", async () => {
  const markdown = await renderHtml(
    "<html><body><h1>Title</h1><p>Hello <strong>bold</strong> and <a href='https://x.test'>link</a></p></body></html>",
  );
  assert.match(markdown, /^# Title/m);
  assert.match(markdown, /Hello \*\*bold\*\* and \[link\]\(https:\/\/x\.test\)/);
});

test("renders lists and code", async () => {
  const markdown = await renderHtml(
    "<html><body><ul><li>one</li><li>two</li></ul><pre><code>x = 1</code></pre></body></html>",
  );
  assert.match(markdown, /- one/);
  assert.match(markdown, /- two/);
  assert.match(markdown, /```\n/);
});

test("renders images and page breaks", async () => {
  const markdown = await renderHtml(
    '<html><body><img src="embedded:a.png" alt="A"/><div class="page"></div></body></html>',
  );
  assert.match(markdown, /!\[A\]\(embedded:a\.png\)/);
  assert.match(markdown, /---/);
});
