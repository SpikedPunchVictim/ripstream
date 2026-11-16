import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MemoryPool } from "@spikedpunch/ripstream-isolation-node";
import { createRipstream } from "../src/index.ts";
import { createStandardIsolation } from "../src/isolation.ts";

/**
 * tikajs-5qkk: `ParseOptions.emailHeaders` writes an email's header block ahead of its body text. Off by default, which is
 * Tika's output; the metadata is the same either way. In-process and isolated answers agree, `parse` and `parseRecursive`.
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
  test(`${arm}: the default text of an email is its body alone`, { timeout: 60_000 }, async () => {
    const result = await ripstream.parse(EML, { filename: "q.eml" });
    assert.equal(result.text, "The numbers are attached.\n\n\n");
  });

  test(`${arm}: emailHeaders puts the header block ahead of the body and changes no metadata`, { timeout: 60_000 }, async () => {
    const plain = await ripstream.parse(EML, { filename: "q.eml" });
    const result = await ripstream.parse(EML, { filename: "q.eml", emailHeaders: true });
    assert.equal(result.text, `${BLOCK}The numbers are attached.\n\n\n`);
    for (const name of plain.metadata.names()) {
      if (name === "tk:parse-time-millis") continue;
      assert.deepEqual(result.metadata.getAll(name), plain.metadata.getAll(name), name);
    }
    assert.deepEqual([...result.metadata.names()].sort(), [...plain.metadata.names()].sort());
  });

  test(`${arm}: parseRecursive carries the block in the container's content`, { timeout: 60_000 }, async () => {
    const [container] = await ripstream.parseRecursive(EML, { filename: "q.eml", emailHeaders: true });
    assert.ok(container!.content.includes(`${BLOCK}The numbers are attached.`), JSON.stringify(container!.content));
  });
}
