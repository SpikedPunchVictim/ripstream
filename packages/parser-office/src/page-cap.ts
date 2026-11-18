import { limitError, type ParseContext } from "@spikedpunch/ripstream-core";

/** `ParseLimits.maxPages`, checked before any text of the document is written. */
export function capPages(ctx: ParseContext, count: number, unit: string): void {
  const max = ctx.limits.maxPages;
  if (max !== undefined && count > max) throw limitError(`Document has ${count} ${unit}, exceeding the ${max} page limit`, "pages", count, max);
}
