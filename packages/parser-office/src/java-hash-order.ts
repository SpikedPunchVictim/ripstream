/*
 * The order java.util.HashMap iterates its keys in, for a map filled with `keys` by put. Tika's EpubParser walks the manifest
 * through a HashMap, so the order it hands embedded items to the extractor is this order and not the manifest's.
 *
 * A key lands in bucket `spread(hashCode) & (capacity - 1)`; iteration walks the buckets in order, and the keys of one bucket
 * in the order they were put (a resize splits a bucket without reordering it). The table starts at 16 and doubles when the
 * size passes three quarters of it. A bucket of eight or more keys becomes a tree in Java, which this does not follow.
 */
export function javaHashMapOrder(keys: readonly string[]): string[] {
  const distinct = [...new Set(keys)];
  let capacity = 16;
  while (distinct.length > capacity * 0.75) capacity *= 2;
  const buckets: string[][] = Array.from({ length: capacity }, () => []);
  for (const key of distinct) buckets[bucketOf(key, capacity)]!.push(key);
  return buckets.flat();
}

function bucketOf(key: string, capacity: number): number {
  const hash = stringHashCode(key);
  return (hash ^ (hash >>> 16)) & (capacity - 1);
}

/** String.hashCode: s[0]*31^(n-1) + ... + s[n-1] over UTF-16 code units, in 32-bit arithmetic. */
function stringHashCode(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return hash;
}
