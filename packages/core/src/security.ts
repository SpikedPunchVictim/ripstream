import type { Metadata } from "./metadata.ts";

const SENSITIVE_KEY =
  /(password|passwd|secret|token|credential|api[_-]?key|authorization|private[_-]?key)/i;

export interface RedactOptions {
  readonly replacement?: string;
  readonly extraKeys?: readonly string[];
}

/** Replaces credential-like metadata values before logging or serialization. */
export function redactMetadata(
  metadata: Metadata,
  options: RedactOptions = {},
): Metadata {
  const replacement = options.replacement ?? "[redacted]";
  const extra = new Set((options.extraKeys ?? []).map((key) => key.toLowerCase()));
  for (const name of metadata.names()) {
    if (SENSITIVE_KEY.test(name) || extra.has(name.toLowerCase())) {
      metadata.set(name, replacement);
    }
  }
  return metadata;
}

export class UnsafePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePatternError";
  }
}

export interface SafeRegexOptions {
  readonly maxLength?: number;
  readonly maxInputLength?: number;
}

const NESTED_QUANTIFIER =
  /(\((?:[^()]|\\.)*[+*](?:[^()]|\\.)*\))(?:[+*]|\{\d+,\})/;

/** Compiles a user pattern after rejecting common catastrophic-backtracking shapes. */
export function compileSafeRegex(
  pattern: string,
  flags = "",
  options: SafeRegexOptions = {},
): RegExp {
  const maxLength = options.maxLength ?? 1_000;
  if (pattern.length > maxLength) {
    throw new UnsafePatternError(`Pattern exceeds ${maxLength} characters`);
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw new UnsafePatternError("Nested quantifiers are not allowed");
  }
  if (/\([^()]*\|[^()]*\)\s*(?:[+*]|\{\d+,\})/.test(pattern)) {
    throw new UnsafePatternError("Quantified alternation is not allowed");
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new UnsafePatternError(
      `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Tests a user pattern with an input-size cap. */
export function safeRegexTest(
  pattern: string,
  value: string,
  flags = "",
  options: SafeRegexOptions = {},
): boolean {
  const maxInputLength = options.maxInputLength ?? 65_536;
  if (value.length > maxInputLength) {
    throw new UnsafePatternError(`Input exceeds ${maxInputLength} characters`);
  }
  return compileSafeRegex(pattern, flags, options).test(value);
}
