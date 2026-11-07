export type RipstreamErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "ENCRYPTED_DOCUMENT"
  | "MALFORMED_DOCUMENT"
  | "WRITE_LIMIT_REACHED"
  | "PARSE_TIMEOUT"
  | "REQUEST_TOO_LARGE"
  | "LIMIT_EXCEEDED"
  | "MISSING_DEPENDENCY"
  | "RANDOM_ACCESS_UNAVAILABLE"
  | "PARSER_DECLINED"
  | "EMPTY_DOCUMENT"
  | "ABORTED"
  | "UNSUPPORTED_RUNTIME";

export class RipstreamError extends Error {
  readonly code: RipstreamErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: RipstreamErrorCode,
    message: string,
    options: { cause?: unknown; recoverable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.recoverable = options.recoverable ?? false;
  }
}

export class UnsupportedFormatError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("UNSUPPORTED_FORMAT", message, options);
  }
}

export class EncryptedDocumentError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("ENCRYPTED_DOCUMENT", message, options);
  }
}

export class MalformedDocumentError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("MALFORMED_DOCUMENT", message, options);
  }
}

export class WriteLimitReachedError extends RipstreamError {
  readonly limit: number;

  constructor(limit: number) {
    super("WRITE_LIMIT_REACHED", `Write limit of ${limit} characters reached`, {
      recoverable: true,
    });
    this.limit = limit;
  }
}

export class ParseTimeoutError extends RipstreamError {
  constructor(message = "Parse timed out", options: { cause?: unknown } = {}) {
    super("PARSE_TIMEOUT", message, { ...options, recoverable: true });
  }
}

export class RequestTooLargeError extends RipstreamError {
  constructor(message = "Request too large") {
    super("REQUEST_TOO_LARGE", message);
  }
}

export class LimitExceededError extends RipstreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("LIMIT_EXCEEDED", message, { ...options, recoverable: true });
  }
}

export class MissingDependencyError extends RipstreamError {
  readonly dependency: string;
  readonly capability: string;

  constructor(dependency: string, capability: string) {
    super(
      "MISSING_DEPENDENCY",
      `Missing optional dependency "${dependency}" required for ${capability}. Install it to enable this parser.`,
    );
    this.dependency = dependency;
    this.capability = capability;
  }
}

export class RandomAccessUnavailableError extends RipstreamError {
  constructor(message: string) {
    super("RANDOM_ACCESS_UNAVAILABLE", message);
  }
}

export class ParserDeclinedError extends RipstreamError {
  constructor(message: string) {
    super("PARSER_DECLINED", message, { recoverable: true });
  }
}

export class EmptyDocumentError extends RipstreamError {
  constructor(message = "Empty document") {
    super("EMPTY_DOCUMENT", message);
  }
}

export class AbortError extends RipstreamError {
  constructor(message = "Operation aborted") {
    super("ABORTED", message, { recoverable: true });
  }
}

export class UnsupportedRuntimeError extends RipstreamError {
  constructor(message: string) {
    super("UNSUPPORTED_RUNTIME", message);
  }
}

/**
 * Server status mapping. Unsupported formats use 415 (upstream's media-type
 * contract); malformed, encrypted, and over-limit documents use 422; a
 * write-limit hit still produced content, so it maps to 200.
 */
export function httpStatusForError(error: unknown): number {
  if (!(error instanceof RipstreamError)) return 500;
  switch (error.code) {
    case "UNSUPPORTED_FORMAT":
      return 415;
    case "ENCRYPTED_DOCUMENT":
    case "MALFORMED_DOCUMENT":
    case "LIMIT_EXCEEDED":
      return 422;
    case "WRITE_LIMIT_REACHED":
    case "EMPTY_DOCUMENT":
      return 200;
    case "PARSE_TIMEOUT":
      return 408;
    case "REQUEST_TOO_LARGE":
      return 413;
    case "MISSING_DEPENDENCY":
    case "RANDOM_ACCESS_UNAVAILABLE":
    case "PARSER_DECLINED":
    case "ABORTED":
    case "UNSUPPORTED_RUNTIME":
      return 500;
  }
}
