import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortError,
  AdmissionRefusedError,
  EncryptedDocumentError,
  IsolationError,
  LIMIT_REASONS,
  LimitExceededError,
  MalformedDocumentError,
  MissingDependencyError,
  ParseTimeoutError,
  RequestTooLargeError,
  RipstreamError,
  UnsupportedFormatError,
  WriteLimitReachedError,
  httpStatusForError,
  isLimitReason,
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
    [new AdmissionRefusedError("pool too small"), "ADMISSION_REFUSED"],
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

test("a pool refusal is not a limit: its own class, code and base, and still 422 and recoverable", () => {
  const error = new AdmissionRefusedError("pool too small");
  assert.equal(error.name, "AdmissionRefusedError");
  assert.equal(error.code, "ADMISSION_REFUSED");
  assert.ok(error instanceof RipstreamError);
  assert.ok(!(error instanceof LimitExceededError));
  assert.equal("limit" in error, false);
  assert.equal(error.recoverable, true);
  assert.equal(httpStatusForError(error), 422);
});

test("a limit error says which limit, and carries the numbers only when the site knew them", () => {
  const bare = new LimitExceededError("too much");
  assert.equal(bare.limit, "other");
  assert.equal(bare.observed, undefined);
  assert.equal(bare.max, undefined);
  assert.equal("observed" in bare, false);
  assert.equal(bare.recoverable, true);

  const cause = new Error("inner");
  const full = new LimitExceededError("Entries 11 exceed 10", { limit: "zipEntries", observed: 11, max: 10, cause });
  assert.equal(full.limit, "zipEntries");
  assert.equal(full.observed, 11);
  assert.equal(full.max, 10);
  assert.equal(full.cause, cause);
  assert.equal(full.code, "LIMIT_EXCEEDED");
});

test("isLimitReason accepts exactly the listed reasons", () => {
  for (const reason of LIMIT_REASONS) assert.ok(isLimitReason(reason), reason);
  for (const value of ["maxZipEntries", "", undefined, 3, null, "__proto__"]) assert.ok(!isLimitReason(value), String(value));
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
