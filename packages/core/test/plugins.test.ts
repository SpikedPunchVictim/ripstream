import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginRegistry } from "../src/index.ts";

test("registers, configures and initializes plugins once", async () => {
  const registry = new PluginRegistry();
  const events: string[] = [];
  const plugin = {
    name: "demo",
    configure(options: Readonly<Record<string, unknown>>) {
      events.push(`configure:${String(options.value)}`);
    },
    initialize() {
      events.push("initialize");
    },
  };
  registry.register(plugin);
  await registry.initializeAll({ demo: { ...plugin, value: 1 } as never });
  await registry.initializeAll();
  assert.deepEqual(events, ["configure:1", "initialize"]);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("demo"), plugin);
});

test("rejects duplicate and unnamed plugins", () => {
  const registry = new PluginRegistry();
  registry.register({ name: "a" });
  assert.throws(() => registry.register({ name: "a" }));
  assert.throws(() => registry.register({ name: " " }));
});
