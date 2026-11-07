import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_KEYS,
  ParseContext,
  ParseContextKey,
  TemporaryResources,
} from "../src/parse-context.ts";
import { AbortError } from "../src/errors.ts";

test("stores typed values and supports has/remove", () => {
  const context = new ParseContext();
  const key = new ParseContextKey<number>("n");
  context.set(key, 42);
  assert.equal(context.get(key), 42);
  assert.equal(context.has(key), true);
  context.remove(key);
  assert.equal(context.has(key), false);
  assert.equal(context.get(key), undefined);
});

test("child contexts inherit values and share resources", () => {
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.LOCALE, "en");
  const child = context.createChild({ limits: { maxOutputChars: 10 } });
  assert.equal(child.get(CONTEXT_KEYS.LOCALE), "en");
  assert.equal(child.limits.maxOutputChars, 10);
  assert.equal(child.limits.maxNodeDepth, context.limits.maxNodeDepth);
  assert.equal(child.resources, context.resources);
});

test("aborting throws the abort reason or AbortError", () => {
  const controller = new AbortController();
  const context = new ParseContext({ signal: controller.signal });
  controller.abort(new Error("stop now"));
  assert.throws(() => context.throwIfAborted(), /stop now/);

  const bare = new AbortController();
  const other = new ParseContext({ signal: bare.signal });
  bare.abort();
  assert.throws(() => other.throwIfAborted(), AbortError);
});

test("limits merge with defaults", () => {
  const context = new ParseContext({ limits: { maxEmbeddedResources: 5 } });
  assert.equal(context.limits.maxEmbeddedResources, 5);
  assert.equal(context.limits.maxOutputChars, 100_000);
});

test("temporary resources close in reverse order and aggregate errors", async () => {
  const resources = new TemporaryResources();
  const closed: number[] = [];
  resources.add({ close: () => { closed.push(1); } });
  resources.add({ close: () => { closed.push(2); } });
  resources.add({
    close: () => {
      throw new Error("boom");
    },
  });

  await assert.rejects(resources.closeAll(), AggregateError);
  assert.deepEqual(closed, [2, 1]);
  assert.equal(resources.size, 0);
});
