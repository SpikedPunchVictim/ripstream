import { type ParseContext } from "@spikedpunch/ripstream-core";

export { isFatalParseError as isFatal } from "@spikedpunch/ripstream-core";


/** What a recorded failure says: the error's name and message, where Tika records a stack trace. */
export function describeFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
