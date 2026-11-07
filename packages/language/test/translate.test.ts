import assert from "node:assert/strict";
import { test } from "node:test";
import { ReliableTranslator, RemoteTranslator } from "../src/index.ts";

test("LibreTranslate adapter posts JSON and reads translatedText", async () => {
  let body: unknown;
  const translator = new RemoteTranslator({
    provider: "libre",
    fetchImpl: (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ translatedText: "bonjour" }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(await translator.translate("hello", "fr", "en"), "bonjour");
  assert.deepEqual(body, { q: "hello", target: "fr", source: "en", format: "text" });
});

test("reliable translator retries and enforces timeout", async () => {
  let calls = 0;
  const flaky = {
    async translate() {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
  };
  assert.equal(await new ReliableTranslator(flaky, { attempts: 3 }).translate("x", "fr"), "ok");
  assert.equal(calls, 3);

  const hanging = { async translate() { await new Promise(() => undefined); return "never"; } };
  await assert.rejects(
    new ReliableTranslator(hanging, { attempts: 1, timeoutMs: 20 }).translate("x", "fr"),
    /timed out/,
  );
});
