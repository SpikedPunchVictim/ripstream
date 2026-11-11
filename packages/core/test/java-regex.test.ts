import assert from "node:assert/strict";
import { test } from "node:test";
import { compileJavaRegex } from "../src/java-regex.ts";

function group1(pattern: string, input: string): string | undefined {
  return compileJavaRegex(pattern).exec(input)?.[1];
}

function matches(pattern: string, input: string): boolean {
  return compileJavaRegex(pattern).test(input);
}

test("\\A is the start of the input, as in Tika's own example for stripping the parameters off a media type", () => {
  assert.equal(group1("\\A([^;]+)", "text/plain; charset=UTF-8"), "text/plain");
  assert.equal(matches("\\Afoo", "xfoo"), false);
});

test("\\A is the start of the input even when ^ would match after a line break", () => {
  assert.equal(matches("(?m)\\Afoo", "bar\nfoo"), false);
  assert.equal(matches("(?m)^foo", "bar\nfoo"), true);
});

test("\\z is the very end of the input, and \\Z the end or just before a final line terminator", () => {
  assert.equal(matches("foo\\z", "foo"), true);
  assert.equal(matches("foo\\z", "foo\n"), false);
  assert.equal(matches("foo\\Z", "foo"), true);
  assert.equal(matches("foo\\Z", "foo\n"), true);
  assert.equal(matches("foo\\Z", "foo\r\n"), true);
  assert.equal(matches("foo\\Z", "foo\nbar"), false);
});

test("\\z and \\Z are the end of the input even under (?m), where $ is the end of each line", () => {
  assert.equal(matches("(?m)foo\\z", "foo\nbar"), false);
  assert.equal(matches("(?m)foo\\Z", "foo\nbar"), false);
  assert.equal(matches("(?m)foo\\z", "bar\nfoo"), true);
});

test("$ is the end or just before a final line terminator, and before any line break under (?m)", () => {
  assert.equal(matches("foo$", "foo"), true);
  assert.equal(matches("foo$", "foo\n"), true);
  assert.equal(matches("foo$", "foo\nbar"), false);
  assert.equal(matches("(?m)foo$", "foo\nbar"), true);
});

test("a $ in a character class is a dollar sign", () => {
  assert.equal(matches("^[$]$", "$"), true);
  assert.equal(matches("^[$]$", ""), false);
});

test("an escaped backslash before A is a backslash and an A", () => {
  assert.equal(matches("^\\\\A$", "\\A"), true);
});

test("\\Q...\\E matches its text literally, and a \\Q with no \\E quotes to the end", () => {
  assert.equal(matches("^\\Qa.b*\\E$", "a.b*"), true);
  assert.equal(matches("^\\Qa.b*\\E$", "axbb"), false);
  assert.equal(matches("^x\\Qa.b", "xa.b"), true);
  assert.equal(matches("^x\\Qa.b", "xaxb"), false);
});

test(". does not match a line terminator, including NEL, unless (?s) is given", () => {
  for (const terminator of ["\n", "\r", "\u0085", " ", " "]) {
    assert.equal(matches("^a.b$", `a${terminator}b`), false, JSON.stringify(terminator));
    assert.equal(matches("(?s)^a.b$", `a${terminator}b`), true, JSON.stringify(terminator));
  }
  assert.equal(matches("^a.b$", "axb"), true);
});

test(". matches a whole code point", () => {
  assert.equal(matches("^.$", "\u{1F600}"), true);
});

test("leading inline flags set i, m and s", () => {
  assert.equal(matches("(?i)abc", "xABCx"), true);
  assert.equal(matches("(?is)^a.c$", "A\nC"), true);
  assert.equal(matches("(?im)^b$", "a\nB"), true);
});

test("flags may be given in more than one leading group", () => {
  assert.equal(matches("(?i)(?s)^a.c$", "A\nC"), true);
});

test("a \\Q...\\E inside a character class is its characters, a hyphen included", () => {
  assert.equal(matches("^[\\Qa-b\\E]+$", "a-b-"), true);
  assert.equal(matches("^[\\Qa-b\\E]$", "c"), false);
});

test("a ] first in a character class is refused, as the engine would read it as an empty class", () => {
  assert.throws(() => compileJavaRegex("[]a]"), /\] first in a character class/);
  assert.throws(() => compileJavaRegex("[^]a]"), /\] first in a character class/);
});

test("a flag the translator cannot honour is refused by name", () => {
  for (const flag of ["x", "d", "u", "U", "c"]) {
    assert.throws(() => compileJavaRegex(`(?${flag})a`), new RegExp(`flag "${flag}"`), flag);
  }
});

test("an inline flag group that is not at the start is refused, as the engine cannot read it", () => {
  assert.throws(() => compileJavaRegex("a(?i)b"), RangeError);
});

test("a nested character class and a character class intersection are refused, not read differently", () => {
  assert.throws(() => compileJavaRegex("[a[bc]]"), /nested character class/);
  assert.throws(() => compileJavaRegex("[a-z&&[^b]]"), /character class (intersection|nested)/);
});

test("an escaped bracket inside a character class is the bracket", () => {
  assert.equal(matches("^[\\[\\]]+$", "[]]["), true);
});

test("a construct only Java has is refused rather than matched as a literal letter", () => {
  for (const pattern of ["\\h", "\\R", "\\G", "\\X", "a++", "(?>a)", "\\p{IsAlphabetic}"]) {
    assert.throws(() => compileJavaRegex(pattern), RangeError, pattern);
  }
});

test("\\s is ASCII whitespace only, as in Java, so a no-break space is not one", () => {
  for (const space of [" ", "\t", "\n", "\u000b", "\f", "\r"]) {
    assert.equal(matches("^\\s$", space), true, JSON.stringify(space));
  }
  for (const other of ["\u00a0", "\u2003", "\ufeff", "\u2028", "\u0085"]) {
    assert.equal(matches("^\\s$", other), false, JSON.stringify(other));
  }
});

test("\\s inside a character class, and \\S outside one, read the same way", () => {
  assert.equal(matches("^[\\s,]+$", " ,\t"), true);
  assert.equal(matches("^[\\s,]$", "\u00a0"), false);
  assert.equal(matches("^\\S$", "\u00a0"), true);
  assert.equal(matches("^\\S$", " "), false);
});

test("\\S inside a character class is refused, as the engine cannot say it without the v flag", () => {
  assert.throws(() => compileJavaRegex("[\\S]"), /\\S inside a character class/);
});

test("\\v is refused, as it is a vertical whitespace class in Java and a vertical tab here", () => {
  assert.throws(() => compileJavaRegex("a\\vb"), /\\v is a class of vertical whitespace in Java/);
  assert.equal(matches("^\\\\v$", "\\v"), true);
});

test("a POSIX class is refused, as it is ASCII in Java and Unicode in the engine", () => {
  for (const name of ["Lower", "Upper", "Alpha", "Digit", "Alnum", "Punct", "Graph", "Print", "Blank", "Cntrl", "XDigit", "Space"]) {
    assert.throws(() => compileJavaRegex(`\\p{${name}}`), new RegExp(`POSIX class \\\\p\\{${name}\\}`), name);
    assert.throws(() => compileJavaRegex(`[\\P{${name}}]`), /POSIX class/, name);
  }
});

test("a Unicode category and the ASCII class mean the same in both", () => {
  assert.equal(matches("^\\p{L}+$", "éa"), true);
  assert.equal(matches("^\\p{Lu}$", "a"), false);
  assert.equal(matches("^\\p{ASCII}+$", "abc"), true);
  assert.equal(matches("^\\p{ASCII}$", "é"), false);
});

test("a pattern that is not a regular expression is refused with the reason", () => {
  assert.throws(() => compileJavaRegex("("), /not a valid regular expression "\(": /);
});

test("the pattern matches from the start of the input each time it is used", () => {
  const regex = compileJavaRegex("(a)");
  assert.equal(regex.exec("xa")?.[1], "a");
  assert.equal(regex.exec("xa")?.[1], "a");
});

test("a group that did not take part in the match is undefined", () => {
  assert.equal(group1("(a)|b", "b"), undefined);
});
