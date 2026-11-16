/**
 * Removes the `*` and `_` of emphasis and strong emphasis from a text by CommonMark's rules for them (the delimiter-run
 * algorithm of the spec): a run opens or closes emphasis by what is around it (`2*3*4` is emphasis, `_a_b` is not, `*USE ... *OBJ`
 * is two openers and stays as written), and a delimiter that finds no partner is text. The marks of matched pairs are the
 * only characters removed.
 */

interface Run {
  readonly char: string;
  /** Where the run starts in the text, and how many of its characters were there to begin with. */
  readonly start: number;
  readonly length: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  /** Characters of the run used as the closing end of a pair (taken from its start) and as the opening end (taken from its end). */
  closed: number;
  opened: number;
  prev: number;
  next: number;
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /[\s\p{Zs}]/u;

/** `placeholder` stands for text that is not emphasis's business (a code span, an escaped character): punctuation, as its first character is one. */
export function removeEmphasis(text: string, placeholder?: string): string {
  if (!text.includes("*") && !text.includes("_")) return text;
  const runs = findRuns(text, placeholder);
  if (runs.length === 0) return text;
  matchRuns(runs);
  if (runs.every((run) => run.closed === 0 && run.opened === 0)) return text;
  const removed = new Uint8Array(text.length);
  for (const run of runs) {
    // The characters of a run used to close a pair are its first ones, those used to open one its last ones.
    for (let index = 0; index < run.closed; index++) removed[run.start + index] = 1;
    for (let index = 0; index < run.opened; index++) removed[run.start + run.length - 1 - index] = 1;
  }
  let out = "";
  for (let index = 0; index < text.length; index++) if (removed[index] === 0) out += text[index];
  return out;
}

function findRuns(text: string, placeholder: string | undefined): Run[] {
  const runs: Run[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char !== "*" && char !== "_") {
      index++;
      continue;
    }
    let end = index;
    while (text[end] === char) end++;
    const before = index === 0 ? undefined : lastCharacter(text, index);
    const after = end >= text.length ? undefined : firstCharacter(text, end);
    const beforeSpace = before === undefined || WHITESPACE.test(before);
    const afterSpace = after === undefined || WHITESPACE.test(after);
    const beforePunctuation = before !== undefined && (before === placeholder || PUNCTUATION.test(before));
    const afterPunctuation = after !== undefined && (after === placeholder || PUNCTUATION.test(after));
    const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
    const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
    const canOpen = char === "*" ? left : left && (!right || beforePunctuation);
    const canClose = char === "*" ? right : right && (!left || afterPunctuation);
    runs.push({ char, start: index, length: end - index, canOpen, canClose, closed: 0, opened: 0, prev: runs.length - 1, next: runs.length + 1 });
    index = end;
  }
  return runs;
}

function lastCharacter(text: string, end: number): string {
  const low = text.charCodeAt(end - 1);
  if (low >= 0xdc00 && low <= 0xdfff && end >= 2) return text.slice(end - 2, end);
  return text[end - 1]!;
}

function firstCharacter(text: string, start: number): string {
  const code = text.codePointAt(start)!;
  return String.fromCodePoint(code);
}

/** Pairs the runs, the closers from the left, each with the nearest opener before it that may match (spec: "process emphasis"). */
function matchRuns(runs: Run[]): void {
  const remaining = (run: Run): number => run.length - run.closed - run.opened;
  const unlink = (index: number): void => {
    const run = runs[index]!;
    if (run.prev >= 0) runs[run.prev]!.next = run.next;
    if (run.next < runs.length) runs[run.next]!.prev = run.prev;
  };
  // Where the search for an opener stops, by what the closer is: a failed search is not repeated further back.
  const bottoms = new Map<string, number>();
  let closer = 0;
  while (closer < runs.length) {
    const close = runs[closer]!;
    if (!close.canClose) {
      closer = close.next;
      continue;
    }
    const key = `${close.char}${close.canOpen ? 1 : 0}${close.length % 3}`;
    const bottom = bottoms.get(key) ?? -1;
    let opener = close.prev;
    let found = -1;
    while (opener > bottom && opener >= 0) {
      const open = runs[opener]!;
      // Rule of three: when either can both open and close, their lengths together are not a multiple of 3 unless each is.
      const oddMatch = (close.canOpen || open.canClose) && close.length % 3 !== 0 && (open.length + close.length) % 3 === 0;
      if (open.char === close.char && open.canOpen && !oddMatch) {
        found = opener;
        break;
      }
      opener = open.prev;
    }
    if (found < 0) {
      bottoms.set(key, close.prev);
      const next = close.next;
      if (!close.canOpen) unlink(closer);
      closer = next;
      continue;
    }
    const open = runs[found]!;
    const use = remaining(open) >= 2 && remaining(close) >= 2 ? 2 : 1;
    open.opened += use;
    close.closed += use;
    // Runs between the pair are inside it: they can no longer match anything.
    open.next = closer;
    close.prev = found;
    if (remaining(open) === 0) unlink(found);
    if (remaining(close) === 0) {
      const next = close.next;
      unlink(closer);
      closer = next;
    }
  }
}
