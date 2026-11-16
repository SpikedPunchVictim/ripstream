import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEmailHtml } from "../src/mail-html.ts";

// The expected texts are what the xberg 1.4.0 CLI writes for a text/html email body (its plain renderer), run against
// the same fragments.
const CASES: readonly (readonly [string, string])[] = [
  ["<p>Hello world</p>", "Hello world"],
  ["<h1>Title</h1>", "  Title"],
  ["<h2>Sub</h2>", "  Sub"],
  ["<h1>Title</h1><p>Para</p>", "  Title\n  Para"],
  ["<ul><li>one</li><li>two</li></ul>", "one\ntwo"],
  ["<ol><li>one</li><li>two</li></ol>", "one\ntwo"],
  ["<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>", "A B\nC D"],
  ["<div>Inside</div><div>Second</div>", "Inside\n\nSecond"],
  ["<p>a<br>b</p>", "a\nb"],
  ["<p>a <b>bold</b> and <i>it</i></p>", "a bold and it"],
  ["<pre>x\ny</pre>", "x\ny"],
  ["<blockquote>quoted</blockquote>", "  quoted"],
  ["<h1>T</h1><p>P1</p><ul><li>L1</li></ul><p>P2</p>", "  T\n  P1\n\nL1\n  P2"],
  ["<p>one</p><p>two</p>", "one\n\ntwo"],
  ["<p></p><p>x</p>", "x"],
  ['<p>x <a href="http://e">link</a> y</p>', "x link y"],
  ['<p>before <img src="x.png" alt="pic"> after</p>', "before\n\npic\n\nafter"],
  ["<p>a</p><hr><p>b</p>", "a\n\nb"],
  ["<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>", "a\nb\nc\nd"],
  ["<h1>A</h1><h2>B</h2><p>C</p>", "  A\n    B\n    C"],
  ["<p>one</p><ul><li>x</li></ul><p>two</p>", "one\n\nx\ntwo"],
  ["<blockquote><p>a</p><p>b</p></blockquote>", "  a\n\n  b"],
  ["<table><tr><th>H</th><th>I</th></tr><tr><td>D</td><td>E</td></tr></table>", "H I\nD E"],
  ["<div><p>x</p></div><p>y</p>", "x\n\ny"],
  ["<p>a&nbsp;b</p>", "a b"],
  ["<p><strong>B</strong>text</p>", "Btext"],
  ["<p>line1\nline2</p>", "line1 line2"],
  ["<ul><li><p>para</p></li></ul>", "para"],
  ["<table><tr><td>A</td><td>B</td><td>C</td></tr></table>", "A B C"],
  ['<p>x <img src="y.png"> z</p>', "x\n\n[Image]\n\nz"],
  ["<table><tr><td>A</td></tr></table><p>after</p>", "A\n\nafter"],
  ["<p>before</p><h2>Head</h2><p>after</p>", "before\n\n  Head\n  after"],
  ["<h1>T</h1><blockquote><p>q</p></blockquote><p>p</p>", "  T\n  q\n\n  p"],
];

for (const [html, expected] of CASES) {
  test(`email HTML renders as xberg writes it: ${html}`, () => {
    assert.equal(renderEmailHtml(html), expected);
  });
}
