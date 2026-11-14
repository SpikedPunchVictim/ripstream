import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

/*
 * A reader that goes away early (`ripstream parse big.txt | head -c 20`) is no crash: the command stops quietly, as a
 * command line tool does, and does not print Node's stack trace for an unhandled stream error.
 */

test("a reader that closes the pipe early ends the command without a stack trace", async () => {
  const text = "a line of text to fill the pipe\n".repeat(2900); // 90 KB: more than a pipe holds, under the output limit
  const child = spawn(process.execPath, ["packages/cli/bin/ripstream.js", "parse", "-"], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  // The reader is gone before the command has anything to write, as when `head` has had its fill.
  child.stdout.destroy();
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.stdin.end(text);
  const code = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the command did not end")), 10_000))]);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'|at .*:\d+:\d+/);
  assert.equal(code, 0);
});
