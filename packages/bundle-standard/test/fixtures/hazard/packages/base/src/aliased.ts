class InternalNameParser {
  getSupportedTypes(): ReadonlySet<{ toString(): string }> {
    return new Set([{ toString: () => "application/x-fixture-aliased" }]);
  }

  async parse(): Promise<void> {
    await import("sql.js");
  }
}

// Declared as InternalNameParser, reachable only as AliasedPublicParser: looking the class up by its declared name finds nothing.
export { InternalNameParser as AliasedPublicParser };
