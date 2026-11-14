import assert from "node:assert/strict";
import { test } from "node:test";
import { splitPersonAndEmail } from "../src/mail-address.ts";

// The reference: MailUtil.EMAIL as the regex it was before it was replaced by a linear scan.
const EMAIL = /([^<@ \t\n\v\f\r]+@[^@> ]+)/g;
function reference(display: string): { person: string; email: string } {
  let email = "";
  const rest = display.replace(EMAIL, (_match, found: string) => {
    email = found;
    return "";
  });
  return { person: rest.replace(/[<>"]/g, " ").replace(/^[\s\u0000- ]+|[\s\u0000- ]+$/g, ""), email };
}

test("splitPersonAndEmail agrees with the MailUtil regex on addresses, display names and edge cases", () => {
  for (const display of [
    "Ada Lovelace <ada@example.com>",
    '"Last, First" <first.last@example.com>',
    "a@b@c d@e",
    "@@@ x@",
    "x@y<z@w",
    "plain name only",
    "a@b c@d e@f",
    "<@>",
    "tab\tsep@host\tother@h2",
  ]) {
    assert.deepEqual(splitPersonAndEmail(display), reference(display), display);
  }
});

// tikajs-2mo9: the regex retried every start of a long address-like run, so a 99k-character From header took seconds.
test("splitPersonAndEmail is linear on a long run with no @ in it", () => {
  const started = performance.now();
  const result = splitPersonAndEmail("a".repeat(200_000));
  assert.equal(result.email, "");
  assert.ok(performance.now() - started < 1000);
});
