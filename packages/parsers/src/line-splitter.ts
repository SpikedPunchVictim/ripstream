import { LimitExceededError } from "@spikedpunch/ripstream-core";

/** BufferedReader.readLine over decoded chunks: a line ends at \n, \r or \r\n, and the last needs no terminator. */
export class LineSplitter {
  readonly #maxChars: number;
  readonly #what: string;
  #pending = "";
  /** The last chunk ended in \r: a \n at the start of the next one is part of that line end. */
  #skipLineFeed = false;

  /** `what` names a line in the LimitExceededError ("a MIF line"). */
  constructor(maxChars: number, what: string) {
    this.#maxChars = maxChars;
    this.#what = what;
  }

  push(text: string): string[] {
    if (text.length === 0) return [];
    const lines: string[] = [];
    let start = 0;
    if (this.#skipLineFeed) {
      this.#skipLineFeed = false;
      if (text.startsWith("\n")) start = 1;
    }
    const terminator = /[\r\n]/g;
    for (;;) {
      terminator.lastIndex = start;
      const match = terminator.exec(text);
      if (match === null) break;
      lines.push(this.#complete(text.slice(start, match.index)));
      start = match.index + 1;
      if (match[0] === "\r") {
        if (start === text.length) this.#skipLineFeed = true;
        else if (text[start] === "\n") start++;
      }
    }
    this.#pending += text.slice(start);
    this.#check(this.#pending);
    return lines;
  }

  /** What is left at the end of the input: readLine returns it when it is not empty. */
  finish(): string[] {
    const last = this.#pending;
    this.#pending = "";
    return last.length > 0 ? [last] : [];
  }

  #complete(end: string): string {
    const line = this.#pending + end;
    this.#pending = "";
    this.#check(line);
    return line;
  }

  #check(line: string): void {
    if (line.length > this.#maxChars) throw new LimitExceededError(`${this.#what} is longer than ${this.#maxChars} characters`);
  }
}
