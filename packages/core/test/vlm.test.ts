import assert from "node:assert/strict";
import { test } from "node:test";
import { DisabledVlmProvider, VlmError } from "../src/index.ts";

test("disabled VLM provider fails with typed error", async () => {
  await assert.rejects(new DisabledVlmProvider().ocr(), VlmError);
});
