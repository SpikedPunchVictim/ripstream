import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  EncryptedDocumentError,
  IsolationError,
  LimitExceededError,
  MalformedDocumentError,
  MissingDependencyError,
  ParseTimeoutError,
  RequestTooLargeError,
  RipstreamError,
  UnsupportedFormatError,
  WriteLimitReachedError,
  httpStatusForError,
} from "../src/errors.ts";

test("errors carry stable codes and names", () => {
  const errors: Array<[RipstreamError, string]> = [
    [new UnsupportedFormatError("no"), "UNSUPPORTED_FORMAT"],
    [new EncryptedDocumentError("locked"), "ENCRYPTED_DOCUMENT"],
    [new MalformedDocumentError("bad"), "MALFORMED_DOCUMENT"],
    [new WriteLimitReachedError(10), "WRITE_LIMIT_REACHED"],
    [new ParseTimeoutError(), "PARSE_TIMEOUT"],
    [new RequestTooLargeError(), "REQUEST_TOO_LARGE"],
    [new LimitExceededError("too much"), "LIMIT_EXCEEDED"],
    [new MissingDependencyError("pdfjs-dist", "PDF"), "MISSING_DEPENDENCY"],
    [new AbortError(), "ABORTED"],
    [new IsolationError("crash", "child died"), "ISOLATION_FAILED"],
  ];

  for (const [error, code] of errors) {
    assert.equal(error.code, code);
    assert.equal(error.name, error.constructor.name);
  }
});

test("maps errors to server status codes", () => {
  assert.equal(httpStatusForError(new UnsupportedFormatError("no")), 415);
  assert.equal(httpStatusForError(new EncryptedDocumentError("locked")), 422);
  assert.equal(httpStatusForError(new MalformedDocumentError("bad")), 422);
  assert.equal(httpStatusForError(new LimitExceededError("big")), 422);
  assert.equal(httpStatusForError(new WriteLimitReachedError(10)), 200);
  assert.equal(httpStatusForError(new ParseTimeoutError()), 408);
  assert.equal(httpStatusForError(new RequestTooLargeError()), 413);
  assert.equal(httpStatusForError(new Error("plain")), 500);
});

test("missing dependency error names the package and capability", () => {
  const error = new MissingDependencyError("pdfjs-dist", "PDF parsing");
  assert.match(error.message, /pdfjs-dist/);
  assert.match(error.message, /PDF parsing/);
  assert.equal(error.dependency, "pdfjs-dist");
  assert.equal(error.capability, "PDF parsing");
});

test("isolation errors carry a reason and recoverability", () => {
  const full = new IsolationError("queue_full", "pool saturated");
  assert.equal(full.reason, "queue_full");
  assert.equal(full.recoverable, true);
  assert.equal(full.name, "IsolationError");
  assert.ok(full instanceof RipstreamError);
  assert.equal(new IsolationError("unavailable", "no child").recoverable, false);
  assert.equal(new IsolationError("crash", "died").recoverable, false);
  const cause = new Error("spawn failed");
  assert.equal(new IsolationError("unavailable", "no child", { cause }).cause, cause);
});

test("maps isolation errors to server status codes by reason", () => {
  assert.equal(httpStatusForError(new IsolationError("queue_full", "full")), 503);
  assert.equal(httpStatusForError(new IsolationError("unavailable", "none")), 503);
  assert.equal(httpStatusForError(new IsolationError("crash", "died")), 500);
  assert.equal(httpStatusForError(new IsolationError("bogus" as never, "x")), 500);
  // a bare error carrying the code is not an IsolationError
  assert.equal(httpStatusForError(new RipstreamError("ISOLATION_FAILED", "x")), 500);
});
