import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstream } from "../src/index.ts";

const encoder = new TextEncoder();
const ripstream = createRipstream();

test("parses RSS feed entries", async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><item><title>Post</title><description>Body text</description><link>https://example.test/post</link></item></channel></rss>`;
  const result = await ripstream.parse(encoder.encode(rss), { filename: "feed.rss" });
  assert.match(result.text, /Post/);
  assert.match(result.text, /Body text/);
  assert.equal(result.metadata.get("dc:title"), "Feed");
});

test("parses Markdown text", async () => {
  const markdown = "# Title\n\n**bold** and [link](https://x.test)\n\n- item one";
  const result = await ripstream.parse(encoder.encode(markdown), { filename: "doc.md" });
  assert.match(result.text, /Title/);
  assert.match(result.text, /bold and link/);
  assert.match(result.text, /item one/);
  assert.doesNotMatch(result.text, /\*\*|\[link\]/);
  assert.equal(result.metadata.get("Content-Type"), "text/markdown; charset=windows-1252");
  assert.equal(result.metadata.get("Content-Encoding"), "windows-1252");
});
