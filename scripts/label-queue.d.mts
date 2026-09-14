/**
 * Types for `label-queue.mjs`.
 *
 * The module is plain JavaScript because it is loaded by the labelling server at runtime with
 * no build step. Two TypeScript files read it — the trainer, for the lexicons, and the
 * prefilter test, for the canonical example copy — and both need it to be more than `any`,
 * since the whole point of the prefilter test is that those examples are exactly right.
 */
export interface TrainablePattern {
  id: string;
  label: string;
  question: string;
  mechanism: string;
  /** Copy a human is shown as "yes, like this". Asserted against the prefilter. */
  yes: string[];
  no: string[];
  /** The current lexicon. A positive it misses is what justifies a classifier at all. */
  strict: RegExp[];
  loose: RegExp[];
}

export const TRAINABLE: TrainablePattern[];

export interface QueueItem {
  patternId: string;
  tier: "A" | "B" | "C";
  text: string;
  site: string;
  key: string;
  tag: string;
}

export function buildQueue(
  rows: { text: string; site: string; key: string; tag: string }[],
  opts?: { perPattern?: number },
): QueueItem[];
