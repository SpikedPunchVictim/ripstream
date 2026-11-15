/**
 * A counter that moves whenever something a `CompositeParser` ranks by may have changed: a parser added to any
 * composite (a composite can be a parser inside another), or a type, alias or supertype added to any registry. A
 * composite keeps its ranked candidate lists only while the counter is where it was when they were built, so a change
 * anywhere drops every composite's lists. Over-invalidating is cheap, and under-invalidating would route to the wrong
 * parser. Internal: not exported from the package.
 */
let epoch = 0;

export function bumpParserEpoch(): void {
  epoch++;
}

export function currentParserEpoch(): number {
  return epoch;
}
