export type MetadataValue = string | number | boolean | Date;

/**
 * Port of org.apache.tika.metadata.Metadata storage semantics.
 *
 * Upstream uses HashMap<String,String[]> behind a write limiter. Keys are
 * exact and case-sensitive; add appends; set replaces; set(name, null)
 * removes; get returns the first value. Iteration order is unspecified
 * upstream, so callers must not depend on the Map insertion order used here.
 */
export class Metadata implements Iterable<[string, string]> {
  private readonly values = new Map<string, string[]>();
  private maxValueChars = Infinity;

  constructor(initial?: Metadata | Readonly<Record<string, MetadataValue>>) {
    if (initial instanceof Metadata) {
      this.maxValueChars = initial.maxValueChars;
      this.merge(initial);
    } else if (initial !== undefined) {
      for (const [name, value] of Object.entries(initial)) this.set(name, value);
    }
  }

  add(name: string, value: MetadataValue | null | undefined): void {
    if (value == null) return;
    // chisle: reserved-key guard lands with the generated metadata schema.
    const encoded = this.encodeValue(value);
    const existing = this.values.get(name);
    if (existing === undefined) {
      this.values.set(name, [encoded]);
    } else {
      existing.push(encoded);
    }
  }

  set(name: string, value: MetadataValue | null | undefined): void {
    if (value == null) {
      this.values.delete(name);
      return;
    }
    this.values.set(name, [this.encodeValue(value)]);
  }

  /**
   * Truncates every value stored from now on (and existing ones) to at most
   * `max` characters. Callers wire this to ParseLimits.maxMetadataValueChars.
   */
  setMaxValueChars(max: number): void {
    if (Number.isNaN(max) || max < 0) {
      throw new RangeError(`maxValueChars must be a non-negative number, got ${String(max)}`);
    }
    this.maxValueChars = max;
    for (const list of this.values.values()) {
      for (let i = 0; i < list.length; i++) list[i] = list[i]!.slice(0, max);
    }
  }

  private encodeValue(value: MetadataValue): string {
    const encoded = encode(value);
    return encoded.length > this.maxValueChars ? encoded.slice(0, this.maxValueChars) : encoded;
  }

  get(name: string): string | null {
    return this.values.get(name)?.[0] ?? null;
  }

  getAll(name: string): readonly string[] {
    return this.values.get(name) ?? EMPTY;
  }

  getFirst(names: readonly string[]): string | null {
    for (const name of names) {
      const value = this.get(name);
      if (value !== null) return value;
    }
    return null;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  remove(name: string): void {
    this.values.delete(name);
  }

  names(): string[] {
    return [...this.values.keys()];
  }

  size(): number {
    return this.values.size;
  }

  isEmpty(): boolean {
    return this.values.size === 0;
  }

  addAll(name: string, values: readonly MetadataValue[]): void {
    for (const value of values) this.add(name, value);
  }

  setAll(name: string, values: readonly MetadataValue[]): void {
    if (values.length === 0) {
      this.values.delete(name);
      return;
    }
    this.values.set(name, values.map((v) => this.encodeValue(v)));
  }

  getInt(name: string): number | null {
    const value = this.get(name);
    if (value === null || !/^[+-]?\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= -2_147_483_648 && parsed <= 2_147_483_647
      ? parsed
      : null;
  }

  getLong(name: string): bigint | null {
    const value = this.get(name);
    if (value === null || !/^[+-]?\d+$/.test(value)) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  getDouble(name: string): number | null {
    const value = this.get(name);
    if (value === null || value.trim().length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  getBoolean(name: string): boolean | null {
    const value = this.get(name);
    if (value === null) return null;
    const lower = value.toLowerCase();
    return lower === "true" ? true : lower === "false" ? false : null;
  }

  getDate(name: string): Date | null {
    const value = this.get(name);
    if (value === null) return null;
    const parsed = parseTikaDate(value);
    return parsed;
  }

  setDate(name: string, value: Date | null | undefined): void {
    this.set(name, value == null ? null : value.toISOString());
  }

  setInt(name: string, value: number): void {
    this.set(name, Math.trunc(value));
  }

  setBoolean(name: string, value: boolean): void {
    this.set(name, value);
  }

  merge(other: Metadata): void {
    if (other === this) return;
    for (const name of other.names()) this.setAll(name, other.getAll(name));
  }

  clone(): Metadata {
    return new Metadata(this);
  }

  toObject(): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [name, values] of this.values) {
      result[name] = values.length === 1 ? values[0]! : [...values];
    }
    return result;
  }

  *[Symbol.iterator](): Iterator<[string, string]> {
    for (const [name, values] of this.values) {
      for (const value of values) yield [name, value];
    }
  }
}

const EMPTY: readonly string[] = Object.freeze([]);

function encode(value: MetadataValue): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Upstream TikaDates rules: zone-less values are UTC; a date-only value is
 * midday UTC. Partial/invalid dates return null.
 */
function parseTikaDate(value: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly !== null) {
    const [, year, month, day] = dateOnly;
    const parsed = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12),
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = hasZone ? value : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
