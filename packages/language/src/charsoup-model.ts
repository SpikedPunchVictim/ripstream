/*
 * `CharSoupModel` of Apache Tika 4.2.0 (tika-langdetect-charsoup-core), Apache License 2.0: an INT8-quantized multinomial
 * logistic regression, read from the LDM1 binary Tika ships.
 *
 *   magic "LDM1" | version (1 or 2) | numBuckets | numClasses | [featureFlags, version 2 only]
 *   labels: numClasses x (u16 length, UTF-8) | scales: numClasses x float | biases: numClasses x float
 *   weights: numBuckets x numClasses signed bytes, bucket-major
 *
 * Everything is big-endian. Java's `float` arithmetic is kept 32-bit with `Math.fround` where the Java rounds, so that the
 * logits are the ones Tika computes.
 */

/** Feature flag: L2-normalize the feature vector before prediction. */
const FLAG_L2_NORM = 1 << 10;
const MAGIC = 0x4c444d31;
const V1_DEFAULT_FLAGS = 1 << 5; // word unigrams only

export class CharSoupModel {
  readonly numBuckets: number;
  readonly numClasses: number;
  readonly labels: readonly string[];
  readonly featureFlags: number;
  readonly #scales: Float32Array;
  readonly #biases: Float32Array;
  readonly #weights: Int8Array;

  private constructor(
    numBuckets: number,
    numClasses: number,
    labels: readonly string[],
    scales: Float32Array,
    biases: Float32Array,
    weights: Int8Array,
    featureFlags: number,
  ) {
    this.numBuckets = numBuckets;
    this.numClasses = numClasses;
    this.labels = labels;
    this.#scales = scales;
    this.#biases = biases;
    this.#weights = weights;
    this.featureFlags = featureFlags;
  }

  /** Reads a model, or throws saying what is wrong with the bytes. The weights are a view of `bytes`, not a copy. */
  static load(bytes: Uint8Array): CharSoupModel {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const need = (count: number, what: string): void => {
      if (count < 0 || offset + count > bytes.byteLength) throw new Error(`Language model is truncated: it ends before ${what}`);
    };
    const int = (what: string): number => {
      need(4, what);
      const value = view.getInt32(offset);
      offset += 4;
      return value;
    };

    const magic = int("the magic");
    if (magic !== MAGIC) {
      throw new Error(`Invalid language model magic: expected 0x${MAGIC.toString(16).toUpperCase()}, got 0x${(magic >>> 0).toString(16).toUpperCase()}`);
    }
    const version = int("the version");
    if (version !== 1 && version !== 2) throw new Error(`Unsupported language model version: ${version} (expected 1 or 2)`);
    const numBuckets = int("the bucket count");
    const numClasses = int("the class count");
    if (numBuckets <= 0 || numClasses <= 0 || numBuckets * numClasses > 0x7fffffff) {
      throw new Error(`Language model has an impossible shape: ${numBuckets} buckets by ${numClasses} classes`);
    }
    const featureFlags = version === 2 ? int("the feature flags") : V1_DEFAULT_FLAGS;

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const labels: string[] = [];
    for (let c = 0; c < numClasses; c++) {
      need(2, "a label");
      const length = view.getUint16(offset);
      offset += 2;
      need(length, "a label");
      labels.push(decoder.decode(bytes.subarray(offset, offset + length)));
      offset += length;
    }
    const floats = (what: string): Float32Array => {
      need(numClasses * 4, what);
      const values = new Float32Array(numClasses);
      for (let c = 0; c < numClasses; c++) values[c] = view.getFloat32(offset + c * 4);
      offset += numClasses * 4;
      return values;
    };
    const scales = floats("the scales");
    const biases = floats("the biases");
    need(numBuckets * numClasses, "the weights");
    const weights = new Int8Array(bytes.buffer, bytes.byteOffset + offset, numBuckets * numClasses);
    return new CharSoupModel(numBuckets, numClasses, labels, scales, biases, weights, featureFlags);
  }

  /**
   * `predictLogits`: the raw scores of every class for a vector of bucket counts. Only the buckets that are not zero are
   * visited. The result is 32-bit, as Tika's.
   */
  predictLogits(features: Int32Array): Float32Array {
    const { numBuckets, numClasses } = this;
    const nonZero: number[] = [];
    for (let b = 0; b < numBuckets; b++) if (features[b] !== 0) nonZero.push(b);

    let invNorm = 1;
    if ((this.featureFlags & FLAG_L2_NORM) !== 0) {
      let normSq = 0;
      for (const b of nonZero) normSq += features[b]! * features[b]!;
      invNorm = normSq > 0 ? Math.fround(1 / Math.sqrt(normSq)) : 1;
    }

    const dots = new Float64Array(numClasses);
    for (const b of nonZero) {
      const count = features[b]!;
      const base = b * numClasses;
      for (let c = 0; c < numClasses; c++) dots[c]! += this.#weights[base + c]! * count;
    }

    const logits = new Float32Array(numClasses);
    for (let c = 0; c < numClasses; c++) {
      // Java: biases[c] + scales[c] * dots[c] * invNorm, every operation a float one (the long is converted to float first).
      const scaled = Math.fround(Math.fround(this.#scales[c]! * Math.fround(dots[c]!)) * invNorm);
      logits[c] = Math.fround(this.#biases[c]! + scaled);
    }
    return logits;
  }
}
