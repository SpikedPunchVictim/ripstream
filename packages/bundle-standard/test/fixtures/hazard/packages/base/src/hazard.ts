/** Reaches a hazard library, so it is a hazard parser. */
export class HazardParser {
  getSupportedTypes(): ReadonlySet<{ toString(): string }> {
    return new Set([{ toString: () => "application/x-fixture-hazard" }]);
  }

  async parse(): Promise<void> {
    // Never called. The import is what taints this file; the audit only reads it.
    await import("exifr");
  }
}
