/**
 * Statistics as xberg's harness computes them (src/stats.rs, src/aggregate/percentiles.rs):
 * R-7 percentiles (the R and NumPy default), sample standard deviation, and tail
 * percentiles withheld below a minimum sample count.
 */

/** Below these counts p95 / p99 would just be the maximum, so they are not reported. */
export const MIN_SAMPLES_FOR_P95 = 20;
export const MIN_SAMPLES_FOR_P99 = 100;

export function percentileR7(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[Math.min(lower + 1, sorted.length - 1)] ?? low;
  return low + (position - lower) * (high - low);
}

export function tailPercentile(values: readonly number[], fraction: number, minimum: number): number | null {
  return values.length < minimum ? null : percentileR7(values, fraction);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sampleStdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values) ?? 0;
  const squares = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

export function max(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}
