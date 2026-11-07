import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CompositePasswordProvider,
  EmptyPasswordProvider,
  StaticPasswordProvider,
} from "../src/index.ts";

test("password providers resolve in order", () => {
  assert.equal(new StaticPasswordProvider("s").getPassword(), "s");
  assert.equal(new EmptyPasswordProvider().getPassword(), "");
  assert.equal(
    new CompositePasswordProvider([
      { getPassword: () => null },
      new EmptyPasswordProvider(),
      new StaticPasswordProvider("second"),
    ]).getPassword(),
    "",
  );
  assert.equal(
    new CompositePasswordProvider([{ getPassword: () => undefined }]).getPassword(),
    null,
  );
});
