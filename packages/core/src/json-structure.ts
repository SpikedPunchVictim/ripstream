/** The deepest nesting of arrays and objects a configuration file may have. Real ones are two levels deep. */
export const MAX_JSON_DEPTH = 64;

/** Index of the quote that closes the string opening at `start`, or the end of the text if it never closes. */
function endOfString(text: string, start: number): number {
  let end = start + 1;
  while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
  return end;
}

/**
 * What `JSON.parse` accepts without a word and a configuration should not: an object that has the same key twice (the
 * parser keeps the last value) and nesting past MAX_JSON_DEPTH.
 *
 * `text` must already be valid JSON; run this after `JSON.parse` has accepted it. Keys are compared after their
 * escapes are decoded, so `"version"` and `"version"` are the same key.
 */
export function jsonStructureIssues(text: string): string[] {
  const issues: string[] = [];
  /** One entry per open container: the keys an object has had so far, or null for an array. */
  const open: Array<Set<string> | null> = [];
  let expectKey = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      const end = endOfString(text, index);
      if (expectKey) {
        const key = JSON.parse(text.slice(index, end + 1)) as string;
        const keys = open[open.length - 1]!;
        if (keys.has(key)) {
          const issue = `duplicate key ${JSON.stringify(key)}`;
          if (!issues.includes(issue)) issues.push(issue);
        }
        keys.add(key);
        expectKey = false;
      }
      index = end;
    } else if (char === "{" || char === "[") {
      open.push(char === "{" ? new Set() : null);
      if (open.length > MAX_JSON_DEPTH) {
        issues.push(`nesting is deeper than ${MAX_JSON_DEPTH} levels`);
        return issues;
      }
      expectKey = char === "{";
    } else if (char === "}" || char === "]") {
      open.pop();
      expectKey = false;
    } else if (char === ",") {
      expectKey = open[open.length - 1] instanceof Set;
    }
  }
  return issues;
}
