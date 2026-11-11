/**
 * Compiles a `java.util.regex` pattern (the dialect Tika's configuration is written in) to a JavaScript RegExp.
 *
 * The dialects agree on most of what a configuration uses. Where they differ in a way that would match something else
 * without failing, the pattern is either translated or refused:
 *
 * - translated: `\A`, `\z`, `\Z`, `$` (before a final line terminator), `.` (NEL is a line terminator), `\s` and `\S`
 *   (ASCII whitespace only; the engine's also takes a no-break space and the rest of Unicode's), `\Q...\E`, and leading
 *   `(?i)`, `(?m)`, `(?s)` flags;
 * - refused: the other inline flags, a nested character class or an intersection in one (read differently by the
 *   engine), `\v` (a class of vertical whitespace in Java, a vertical tab here), `\S` inside a character class, and
 *   Java's POSIX classes `\p{Alpha}`, `\p{Lower}`, ... (ASCII in Java; the engine knows some of those
 *   names as Unicode properties);
 * - left to the engine, which compiles with the `u` flag so that a construct only Java has (`\h`, `\R`, `\G`, `\X`,
 *   `\p{Alpha}`, a possessive quantifier, an atomic group) is a syntax error, not a literal letter.
 *
 * Case folding is Unicode here and ASCII in Java unless UNICODE_CASE is given: a case-insensitive pattern can match
 * more characters than Tika's.
 */
export function compileJavaRegex(pattern: string): RegExp {
  let flags = "";
  let body = pattern;
  for (;;) {
    const leading = /^\(\?([A-Za-z]+)\)/.exec(body);
    if (leading === null) break;
    for (const flag of leading[1]!) {
      if (flag !== "i" && flag !== "m" && flag !== "s") throw unsupported(pattern, `inline flag "${flag}" is not supported`);
      if (!flags.includes(flag)) flags += flag;
    }
    body = body.slice(leading[0].length);
  }

  const translated = translate(pattern, body, flags.includes("m"), flags.includes("s"));
  try {
    return new RegExp(translated, `${flags}u`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RangeError(`not a valid regular expression ${JSON.stringify(pattern)}: ${reason}`);
  }
}

const LINE_TERMINATORS = "\\r\\n\\u0085\\u2028\\u2029";
const AT_END = "(?![\\s\\S])";
const AT_START = "(?<![\\s\\S])";
const BEFORE_FINAL_TERMINATOR = `(?=(?:\\r\\n|[${LINE_TERMINATORS}])?${AT_END})`;
/** Java's `\s`: space, tab, line feed, vertical tab, form feed, carriage return. */
const ASCII_SPACES = " \\t\\n\\x0B\\f\\r";
const NOT_A_TERMINATOR = `[^${LINE_TERMINATORS}]`;

function unsupported(pattern: string, reason: string): RangeError {
  return new RangeError(`unsupported regular expression ${JSON.stringify(pattern)}: ${reason}`);
}

function translate(pattern: string, body: string, multiline: boolean, dotAll: boolean): string {
  let out = "";
  let inClass = false;
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c === "\\") {
      const next = body[i + 1];
      if (next === undefined) {
        out += c;
        i += 1;
      } else if (next === "Q") {
        const end = body.indexOf("\\E", i + 2);
        out += quote(end === -1 ? body.slice(i + 2) : body.slice(i + 2, end), inClass);
        i = end === -1 ? body.length : end + 2;
      } else if ((next === "p" || next === "P") && posixClassAt(body, i) !== null) {
        throw unsupported(
          pattern,
          `the POSIX class \\${next}{${posixClassAt(body, i)}} is ASCII-only in Java and not the same here; write the characters out`,
        );
      } else if (next === "v") {
        throw unsupported(pattern, "\\v is a class of vertical whitespace in Java and a vertical tab here; write the characters out");
      } else if (next === "s") {
        out += inClass ? ASCII_SPACES : `[${ASCII_SPACES}]`;
        i += 2;
      } else if (next === "S") {
        if (inClass) throw unsupported(pattern, "\\S inside a character class is not supported");
        out += `[^${ASCII_SPACES}]`;
        i += 2;
      } else if (!inClass && next === "A") {
        out += AT_START;
        i += 2;
      } else if (!inClass && next === "z") {
        out += AT_END;
        i += 2;
      } else if (!inClass && next === "Z") {
        out += BEFORE_FINAL_TERMINATOR;
        i += 2;
      } else {
        out += c + next;
        i += 2;
      }
    } else if (inClass) {
      if (c === "[") throw unsupported(pattern, "a nested character class is not supported");
      if (c === "&" && body[i + 1] === "&") throw unsupported(pattern, "a character class intersection is not supported");
      if (c === "]") inClass = false;
      out += c;
      i += 1;
    } else if (c === "[") {
      inClass = true;
      out += c;
      i += 1;
      if (body[i] === "^") {
        out += "^";
        i += 1;
      }
      if (body[i] === "]") throw unsupported(pattern, "a ] first in a character class is not supported");
    } else if (c === "." && !dotAll) {
      out += NOT_A_TERMINATOR;
      i += 1;
    } else if (c === "$" && !multiline) {
      out += BEFORE_FINAL_TERMINATOR;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Java's POSIX character classes; ASCII is the one the engine reads the same way. */
const POSIX_CLASSES: ReadonlySet<string> = new Set([
  "Lower", "Upper", "Alpha", "Digit", "Alnum", "Punct", "Graph", "Print", "Blank", "Cntrl", "XDigit", "Space",
]);

/** The name in a `\p{Name}` or `\P{Name}` at `index` when it is a POSIX class, else null. */
function posixClassAt(body: string, index: number): string | null {
  const name = /^\\[pP]\{([^}]*)\}/.exec(body.slice(index, index + 16))?.[1];
  return name !== undefined && POSIX_CLASSES.has(name) ? name : null;
}

/** `text` as a literal, whether it is outside a character class or inside one (where `-` also has to be escaped). */
function quote(text: string, inClass: boolean): string {
  return text.replace(inClass ? /[\\^$.*+?()[\]{}|/-]/g : /[\\^$.*+?()[\]{}|/]/g, "\\$&");
}
