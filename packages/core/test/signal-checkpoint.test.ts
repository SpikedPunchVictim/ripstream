import assert from "node:assert/strict";
import { test } from "node:test";
import { ParseTimeoutError } from "../src/errors.ts";
import { signalCheckpoint, throwIfAborted } from "../src/signal-checkpoint.ts";

test("throwIfAborted is a no-op when not aborted", () => {
  throwIfAborted({ signal: new AbortController().signal });
  throwIfAborted(undefined);
});

test("throwIfAborted rethrows the timeout reason", () => {
  const c = new AbortController();
  c.abort(new ParseTimeoutError());
  assert.throws(() => throwIfAborted({ signal: c.signal }), ParseTimeoutError);
});

test("throwIfAborted wraps non-Error reasons in AbortError", () => {
  const c = new AbortController();
  c.abort("x");
  assert.throws(() => throwIfAborted({ signal: c.signal }), { code: "ABORTED" });
});

test("signalCheckpoint checks every N ticks", () => {
  const c = new AbortController();
  const tick = signalCheckpoint({ signal: c.signal }, 3);
  c.abort(new Error("stop"));
  tick();
  tick();
  assert.throws(tick, /stop/);
});
