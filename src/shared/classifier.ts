/**
 * Text classification without an LLM (plan §18D).
 *
 * Hashed character n-grams into a fixed-width sparse vector, then a logistic regression.
 * Trained offline; only the weights ship, as a plain array in the rule pack.
 *
 * Why this rather than the obvious alternatives:
 *   - A regex lexicon misses paraphrase. "No thanks, I hate saving money" is caught;
 *     "I'm good, my wallet enjoys the exercise" is not, and there is no finite list that
 *     would catch it.
 *   - An LLM costs latency, money, and the privacy story, the whole product rests on zero
 *     network egress, and a per-page API call would end that.
 *
 * Character n-grams rather than word tokens because they survive the things retailer copy
 * actually does: emoji, punctuation runs, missing spaces, "n0 thanks", British/American
 * spelling. Inference is one sparse dot product, ~microseconds, deterministic, offline,
 * unit-testable.
 */

/** Feature-space width. A power of two so the modulo is a mask. */
export const FEATURE_DIM = 4096;
const DIM_MASK = FEATURE_DIM - 1;

export const NGRAM_MIN = 3;
export const NGRAM_MAX = 5;

/** FNV-1a 32-bit. Fast, well-distributed enough for feature hashing. */
function hashToken(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lowercase, collapse whitespace, pad edges so word starts and ends become features. */
export function normalizeForFeatures(text: string): string {
  return ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
}

/**
 * Hashed character n-grams as a sparse map of index -> count.
 *
 * The signed trick (a second hash deciding +1/-1) cancels hash collisions in expectation
 * rather than letting them accumulate as bias.
 */
export function featurize(text: string): Map<number, number> {
  const s = normalizeForFeatures(text);
  const features = new Map<number, number>();

  for (let n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const gram = s.slice(i, i + n);
      const h = hashToken(gram);
      const idx = h & DIM_MASK;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      features.set(idx, (features.get(idx) ?? 0) + sign);
    }
  }

  // L2 normalise so a long sentence does not simply outscore a short one.
  let norm = 0;
  for (const v of features.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (const [k, v] of features) features.set(k, v / norm);

  return features;
}

export interface StructuralFeatures {
  /** Is the node a decline-role control? */
  isDeclineControl?: boolean;
  /** Sits inside a modal/dialog. */
  inModal?: boolean;
  /** Font size relative to its sibling control, if there is one. */
  relativeFontSize?: number;
}

/** Structural features occupy reserved slots at the top of the vector. */
const STRUCT_BASE = FEATURE_DIM - 8;

function applyStructural(features: Map<number, number>, s: StructuralFeatures): void {
  if (s.isDeclineControl) features.set(STRUCT_BASE, 1);
  if (s.inModal) features.set(STRUCT_BASE + 1, 1);
  if (s.relativeFontSize !== undefined) {
    features.set(STRUCT_BASE + 2, Math.max(-2, Math.min(2, s.relativeFontSize)));
  }
}

export interface ClassifierModel {
  /** Which class this model scores, e.g. "confirmshaming". */
  label: string;
  /** FEATURE_DIM weights. */
  weights: readonly number[];
  bias: number;
  /** Provenance. `hand_set` means these were written by hand, not fitted, see §10. */
  basis: "trained" | "hand_set";
  /** Training-set size when trained; 0 when hand-set. */
  trainedOn: number;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** One sparse dot product. Microseconds. */
export function classify(
  model: ClassifierModel,
  text: string,
  structural: StructuralFeatures = {},
): number {
  const features = featurize(text);
  applyStructural(features, structural);

  let z = model.bias;
  for (const [idx, value] of features) {
    z += value * (model.weights[idx] ?? 0);
  }
  return sigmoid(z);
}

// ----------------------------- training (offline) -----------------------------

export interface TrainingExample {
  text: string;
  label: 0 | 1;
  structural?: StructuralFeatures;
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  /** L2 regularisation. With a few hundred examples in 4096 dims this is load-bearing. */
  l2?: number;
  seed?: number;
}

/**
 * Logistic regression by SGD. Lives here rather than in `research/` so the exact featuriser
 * used at inference is the one used in training, a mismatch between the two is the classic
 * way a model that scores well offline behaves randomly in production.
 *
 * Deterministic given a seed, so a retrain produces byte-identical weights and a diff of the
 * rule pack is reviewable.
 */
export function train(
  label: string,
  examples: TrainingExample[],
  opts: TrainOptions = {},
): ClassifierModel {
  const epochs = opts.epochs ?? 60;
  const lr = opts.learningRate ?? 0.5;
  const l2 = opts.l2 ?? 1e-4;

  const weights = new Array<number>(FEATURE_DIM).fill(0);
  let bias = 0;

  // Deterministic shuffle: a fixed LCG rather than Math.random.
  let seed = opts.seed ?? 42;
  const nextRandom = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const prepared = examples.map((e) => {
    const f = featurize(e.text);
    if (e.structural) applyStructural(f, e.structural);
    return { features: f, label: e.label };
  });

  for (let epoch = 0; epoch < epochs; epoch++) {
    const order = prepared.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      const a = order[i] as number;
      const b = order[j] as number;
      order[i] = b;
      order[j] = a;
    }

    for (const idx of order) {
      const ex = prepared[idx];
      if (!ex) continue;

      let z = bias;
      for (const [k, v] of ex.features) z += v * (weights[k] ?? 0);
      const error = sigmoid(z) - ex.label;

      for (const [k, v] of ex.features) {
        weights[k] = (weights[k] ?? 0) - lr * (error * v + l2 * (weights[k] ?? 0));
      }
      bias -= lr * error;
    }
  }

  return { label, weights, bias, basis: "trained", trainedOn: examples.length };
}

/** Accuracy, precision and recall on held-out data. Reported, never assumed. */
export function evaluate(
  model: ClassifierModel,
  examples: TrainingExample[],
  threshold = 0.5,
): { accuracy: number; precision: number; recall: number; f1: number; n: number } {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (const e of examples) {
    const predicted = classify(model, e.text, e.structural) >= threshold ? 1 : 0;
    if (predicted === 1 && e.label === 1) tp++;
    else if (predicted === 1 && e.label === 0) fp++;
    else if (predicted === 0 && e.label === 0) tn++;
    else fn++;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return {
    accuracy: (tp + tn) / Math.max(1, examples.length),
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    n: examples.length,
  };
}
