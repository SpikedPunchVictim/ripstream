import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitExceededError } from "@spikedpunch/ripstream-core";
import { LineSplitter } from "../src/line-splitter.ts";

/** Every line the splitter finds when the text arrives in the given chunks and is then finished. */
function split(chunks: readonly string[], maxChars = 1000): string[] {
  const splitter = new LineSplitter(maxChars, "a line");
  const lines = chunks.flatMap((chunk) => splitter.push(chunk));
  return [...lines, ...splitter.finish()];
}

test("\\n, \\r and \\r\\n each end a line", () => {
  assert.deepEqual(split(["a\nb\rc\r\nd"]), ["a", "b", "c", "d"]);
});

test("an empty line in the middle is a line", () => {
  assert.deepEqual(split(["a\n\nb"]), ["a", "", "b"]);
});

test("a terminator at the very end does not start another line", () => {
  assert.deepEqual(split(["a\n"]), ["a"]);
  assert.deepEqual(split(["a\r"]), ["a"]);
  assert.deepEqual(split(["a\r\n"]), ["a"]);
});

test("empty input has no lines", () => {
  assert.deepEqual(split([]), []);
  assert.deepEqual(split([""]), []);
});

test("\\r\\n split across two chunks is one line end", () => {
  assert.deepEqual(split(["a\r", "\nb"]), ["a", "b"]);
});

test("\\r at the end of a chunk and \\r at the start of the next are two line ends", () => {
  assert.deepEqual(split(["a\r", "\rb"]), ["a", "", "b"]);
});

test("a line in several chunks is joined", () => {
  assert.deepEqual(split(["ab", "cd", "ef\ngh"]), ["abcdef", "gh"]);
});

test("a line over the cap is a LimitExceededError, whether or not it is finished", () => {
  assert.throws(() => split(["abcdef"], 5), LimitExceededError);
  assert.throws(() => split(["abc", "def\n"], 5), LimitExceededError);
});

test("a line at the cap is not an error", () => {
  assert.deepEqual(split(["abcde\n"], 5), ["abcde"]);
});

test("the error names what the line is", () => {
  assert.throws(
    () => new LineSplitter(1, "a MIF line").push("ab"),
    (error: Error) => error instanceof LimitExceededError && error.message.includes("a MIF line"),
  );
});

test("an empty chunk changes nothing, not even a pending \\r: a \\n after it still finishes that line end", () => {
  assert.deepEqual(split(["a\r", "", "\nb"]), ["a", "b"]);
  assert.deepEqual(split(["a", "", "b\n"]), ["ab"]);
});

test("a chunk of one character is read: a lone \\n or \\r\\n in single-character chunks", () => {
  assert.deepEqual(split(["a", "\n", "b"]), ["a", "b"]);
  assert.deepEqual(split(["a", "\r", "\n", "b"]), ["a", "b"]);
});

test("a \\n after a \\r is skipped once: a \\n in a later chunk is a line end of its own", () => {
  assert.deepEqual(split(["a\r", "\nb", "\nc"]), ["a", "b", "c"]);
});

test("finish returns the last line once, and a second finish has nothing", () => {
  const splitter = new LineSplitter(10, "a line");
  splitter.push("last");
  assert.deepEqual(splitter.finish(), ["last"]);
  assert.deepEqual(splitter.finish(), []);
});

test("the error gives the cap", () => {
  assert.throws(
    () => new LineSplitter(7, "a line").push("12345678"),
    (error: Error) => error instanceof LimitExceededError && error.message.includes("7 characters"),
  );
});

test("a line that is complete in a later chunk is checked with what came before it", () => {
  const splitter = new LineSplitter(5, "a line");
  assert.deepEqual(splitter.push("abc"), []);
  assert.throws(() => splitter.push("def\n"), LimitExceededError);
});
