import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipstream, MediaType } from "../src/index.ts";

test("standard bundle exposes facade and parsers", async () => {
  const ripstream = createRipstream();
  const result = await ripstream.parse(new TextEncoder().encode("bundle text"));
  assert.match(result.text, /bundle text/);
  assert.equal(MediaType.TEXT_PLAIN.toString(), "text/plain");
});
