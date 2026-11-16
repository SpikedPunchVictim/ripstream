import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MemoryPool } from "@spikedpunch/ripstream-isolation-node";
import { createRipstream } from "../src/index.ts";
import { createStandardIsolation } from "../src/isolation.ts";

/**
 * tikajs-5qkk, tikajs-26ut: an email's content is xberg's: the header block, then the body. `emailHeaders: false` leaves
 * the block out; the metadata is the same either way. In-process and isolated answers agree, `parse` and `parseRecursive`.
 */

const EML = new TextEncoder().encode(
  [
    "Date: Tue, 01 Oct 2024 12:34:56 -0500",
    "From: =?UTF-8?Q?J=C3=BCrgen?= <jm@example.com>",
    "To: bob@example.com, sue@example.com",
    "Subject: Quarterly numbers",
    "",
    "The numbers are attached.",
    "",
  ].join("\n"),
);
const BLOCK =
  "Subject: Quarterly numbers\nFrom: Jürgen <jm@example.com>\nTo: bob@example.com, sue@example.com\nDate: Tue, 01 Oct 2024 12:34:56 -0500\n\n";
const BODY = "The numbers are attached.";

const pool = new MemoryPool({ poolMb: 4096, maxQueue: 4 });
const inProcess = createRipstream();
const standard = await createStandardIsolation({ config: { mode: "strict" }, pool });
after(async () => {
  await standard.isolator.dispose();
  await pool.dispose();
});

const arms = [
  ["in-process", inProcess],
  ["isolated", standard.ripstream],
] as const;

for (const [arm, ripstream] of arms) {
  test(`${arm}: the default text of an email is the header block and its body`, { timeout: 60_000 }, async () => {
    const result = await ripstream.parse(EML, { filename: "q.eml" });
    assert.equal(result.text, `${BLOCK}${BODY}`);
  });

  test(`${arm}: emailHeaders false leaves the block out and changes no metadata`, { timeout: 60_000 }, async () => {
    const headed = await ripstream.parse(EML, { filename: "q.eml" });
    const result = await ripstream.parse(EML, { filename: "q.eml", emailHeaders: false });
    assert.equal(result.text, BODY);
    for (const name of headed.metadata.names()) {
      if (name === "tk:parse-time-millis") continue;
      assert.deepEqual(result.metadata.getAll(name), headed.metadata.getAll(name), name);
    }
    assert.deepEqual([...result.metadata.names()].sort(), [...headed.metadata.names()].sort());
  });

  test(`${arm}: parseRecursive carries the block in the container's content`, { timeout: 60_000 }, async () => {
    const [container] = await ripstream.parseRecursive(EML, { filename: "q.eml" });
    assert.ok(container!.content.includes(`${BLOCK}${BODY}`), JSON.stringify(container!.content));
  });
}
