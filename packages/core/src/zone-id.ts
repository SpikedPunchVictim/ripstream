import { daysFromCivil } from "./civil-time.ts";

/** A time zone as far as the date filter needs one: what the offset from UTC is for a local wall-clock time. */
export interface Zone {
  /** The id it was given. */
  readonly id: string;
  /**
   * The offset in seconds that applies to a local time, given as the seconds the wall clock would be since the epoch if it
   * were UTC. A time that does not exist (the clocks went forward) gets the offset before the change, which moves it
   * forward by the length of the gap; one that happens twice gets the earlier of its two offsets. Both as `java.time` does.
   */
  offsetAtLocal(localEpochSeconds: number): number;
}

/**
 * Reads a zone id as `java.time.ZoneId.of` does: `Z`; a numeric offset (`+h`, `+hh`, `+hhmm`, `+hh:mm`, `+hhmmss`,
 * `+hh:mm:ss`, within +-18:00); `UTC`, `GMT` and `UT`, alone or with a numeric offset; or a region such as
 * `America/New_York`. A region id is case-sensitive. Which regions exist, and their rules, are the runtime's tz database's,
 * not the JVM's, so a rare id or an old rule can differ.
 */
export function parseZoneId(id: string): Zone {
  if (id.length <= 1 || id.startsWith("+") || id.startsWith("-")) {
    return fixedZone(id, id === "Z" ? 0 : offsetSecondsOf(id));
  }
  const prefix = id.startsWith("UTC") || id.startsWith("GMT") ? 3 : id.startsWith("UT") ? 2 : 0;
  if (prefix > 0) {
    if (id.length === prefix) return fixedZone(id, 0);
    if (id[prefix] === "+" || id[prefix] === "-") {
      try {
        return fixedZone(id, offsetSecondsOf(id.slice(prefix)));
      } catch {
        throw new RangeError(`Invalid ID for offset-based ZoneId: ${id}`);
      }
    }
  }
  return regionZone(id);
}

function fixedZone(id: string, offset: number): Zone {
  return { id, offsetAtLocal: () => offset };
}

const OFFSET_FORMS: readonly RegExp[] = [
  /^(\d{1,2})$/,
  /^(\d{2})(\d{2})$/,
  /^(\d{2}):(\d{2})$/,
  /^(\d{2})(\d{2})(\d{2})$/,
  /^(\d{2}):(\d{2}):(\d{2})$/,
];

/** `ZoneOffset.of`: a sign and one of the five forms, up to 18:00. */
function offsetSecondsOf(id: string): number {
  const sign = id[0];
  if (sign === "+" || sign === "-") {
    for (const form of OFFSET_FORMS) {
      const match = form.exec(id.slice(1));
      if (match === null) continue;
      const hours = Number(match[1]);
      const minutes = match[2] === undefined ? 0 : Number(match[2]);
      const seconds = match[3] === undefined ? 0 : Number(match[3]);
      const total = hours * 3_600 + minutes * 60 + seconds;
      if (minutes > 59 || seconds > 59 || total > 18 * 3_600) {
        throw new RangeError(`Zone offset not in valid range: -18:00 to +18:00: ${id}`);
      }
      return sign === "-" && total > 0 ? -total : total;
    }
  }
  throw new RangeError(`Invalid ID for ZoneOffset, invalid format: ${id}`);
}

function regionZone(id: string): Zone {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: id,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    throw new RangeError(`Unknown time-zone ID: ${id}`);
  }
  // Intl reads an id in any case and returns the canonical spelling; Java reads it in the case it is written.
  const canonical = formatter.resolvedOptions().timeZone;
  if (canonical !== id && canonical.toLowerCase() === id.toLowerCase()) throw new RangeError(`Unknown time-zone ID: ${id}`);

  const offsetAt = (epochSeconds: number): number => {
    const fields = new Map<string, number>();
    for (const part of formatter.formatToParts(epochSeconds * 1000)) {
      if (part.type !== "literal") fields.set(part.type, Number(part.value));
    }
    const wallClock =
      daysFromCivil(fields.get("year")!, fields.get("month")!, fields.get("day")!) * 86_400 +
      fields.get("hour")! * 3_600 +
      fields.get("minute")! * 60 +
      fields.get("second")!;
    return wallClock - epochSeconds;
  };

  return {
    id,
    offsetAtLocal(local: number): number {
      // A day either side is outside any offset (at most 18 hours), so the two bracket the offsets that can apply.
      const before = offsetAt(local - 86_400);
      const after = offsetAt(local + 86_400);
      if (offsetAt(local - before) === before) return before;
      if (offsetAt(local - after) === after) return after;
      return before;
    },
  };
}
