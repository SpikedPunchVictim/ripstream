import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRipstream } from "../src/index.ts";
import { loadFixtures, runFixture } from "./fixture-runner.ts";

const ripstream = createRipstream();
const root = fileURLToPath(new URL("./fixtures", import.meta.url));

for (const loaded of loadFixtures(root)) {
  test(`fixture ${loaded.name}: ${loaded.fixture.description}`, () => runFixture(ripstream, loaded));
}
