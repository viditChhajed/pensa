/**
 * Train the §18D classifiers from hand labels, and refuse to ship a bad one.
 *
 *   npm run corpus:train
 *
 * The gate is the point of this script, not the training. Plan §10 governs over §8: a
 * detector that cries wolf gets raised or disabled, and there is no reason a model should be
 * exempt from the rule the hand-written detectors live under. So a pattern only produces
 * weights if it has enough positives to have learned anything AND clears a precision bar on
 * data it never saw. Everything else is reported and dropped.
 *
 * The held-out split is by SITE, not by row. Splitting rows at random lets the same sentence
 *, retail markup repeats one string across a page, land on both sides, and the model then
 * scores beautifully on text it has effectively memorised. A site-wise split asks the only
 * question that matters: does this work on a shop it has never seen?
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ClassifierModel, evaluate, type TrainingExample, train } from "@/shared/classifier";
import { TRAINABLE } from "./label-queue.mjs";

const LABELS = resolve("corpus/labels.jsonl");
const OUT = resolve("corpus/models.json");

/** Below this many positives, a 4096-dimension model memorises rather than generalises. */
const MIN_POSITIVES = 40;
/** §10's spirit, applied to a model: more than ~4 false positives out of its firings. */
const MIN_PRECISION = 0.8;
/** A model that only fires on what the lexicon already caught has bought us nothing. */
const MIN_RECALL = 0.5;
/**
 * Negatives per positive.
 *
 * Labelling every snippet against every pattern produces roughly 400 negatives for each
 * positive, and a logistic regression trained on that learns one rule, say no, which
 * scores 99.7% accuracy and is useless. Capped rather than balanced 1:1 because negatives
 * are genuinely the common case and the model should know that.
 */
const NEG_PER_POS = 4;

interface LabelRow {
  patternId: string;
  key: string;
  text: string;
  label?: 0 | 1;
  site?: string;
  tier?: string;
  undo?: boolean;
  /** "no to the one I was asked, but it IS this one". See the labeller's D key. */
  alsoPattern?: string;
  /** Free text, when `alsoPattern` is "other", a technique the taxonomy does not have. */
  alsoText?: string;
}

if (!existsSync(LABELS)) {
  console.error(`No labels at ${LABELS}. Run \`npm run label\` first.`);
  process.exit(1);
}

const byKey = new Map<string, LabelRow>();
for (const line of readFileSync(LABELS, "utf8").trim().split("\n")) {
  if (!line) continue;
  let r: LabelRow;
  try {
    r = JSON.parse(line) as LabelRow;
  } catch {
    continue;
  }
  const id = `${r.patternId}|${r.key}`;
  if (r.undo) byKey.delete(id);
  else byKey.set(id, r);
}

const byPattern = new Map<string, LabelRow[]>();
const unnamed = new Map<string, { count: number; examples: string[] }>();

for (const r of byKey.values()) {
  if (r.label !== 0 && r.label !== 1) continue;
  const list = byPattern.get(r.patternId) ?? [];
  list.push(r);
  byPattern.set(r.patternId, list);

  /**
   * A "no, but it is X" is recorded once and used twice: a NEGATIVE for the pattern that was
   * asked about, and a POSITIVE for the one that was named.
   *
   * This is where most of the yield comes from. Someone labelling scarcity notices a
   * countdown in passing; without somewhere to put that, they answer "no" and the
   * observation, a free positive for another pattern, spotted by a human, is thrown away.
   */
  if (!r.alsoPattern) continue;

  if (r.alsoPattern === "other") {
    // Not trainable: the taxonomy has no such pattern yet. Counted and reported, because a
    // technique named repeatedly by a person looking at real pages is the best evidence
    // there is that the taxonomy is missing something.
    const name = (r.alsoText ?? "unnamed").trim().toLowerCase();
    const entry = unnamed.get(name) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(r.text.slice(0, 70));
    unnamed.set(name, entry);
    continue;
  }

  const other = byPattern.get(r.alsoPattern) ?? [];
  other.push({ ...r, patternId: r.alsoPattern, label: 1 });
  byPattern.set(r.alsoPattern, other);
}

const models: Record<string, ClassifierModel> = {};
const report: string[] = [];
const novelty: string[] = [];

for (const [patternId, rows] of [...byPattern.entries()].sort()) {
  const positives = rows.filter((r) => r.label === 1);
  const negatives = rows.filter((r) => r.label === 0);

  const line = (verdict: string, detail: string): void => {
    report.push(
      `  ${patternId.padEnd(30)} ${String(positives.length).padStart(4)}+ ` +
        `${String(negatives.length).padStart(4)}-  ${verdict.padEnd(10)} ${detail}`,
    );
  };

  if (positives.length < MIN_POSITIVES) {
    line("SKIPPED", `only ${positives.length} positives, need ${MIN_POSITIVES}`);
    continue;
  }

  /**
   * Did the labelling find anything the LEXICON would not have?
   *
   * This is the question the whole §18D exercise turns on. If every positive is one the
   * existing regexes already match, the classifier has learned the lexicon in a more
   * expensive form and the honest thing is to say so rather than ship it. A positive the
   * lexicon misses is the thing that justifies a model at all.
   */
  const strict = TRAINABLE.find((p) => p.id === patternId)?.strict ?? [];
  const lexiconWouldCatch = positives.filter((r) => strict.some((re) => re.test(r.text))).length;
  const novel = positives.length - lexiconWouldCatch;
  novelty.push(
    `  ${patternId.padEnd(30)} ${String(novel).padStart(4)} of ${String(positives.length).padStart(4)} ` +
      `positives are phrasings the lexicon MISSES`,
  );

  // Hold out whole sites. See the header: a row-wise split leaks repeated markup.
  const sites = [...new Set(rows.map((r) => r.site ?? "?"))].sort();
  const holdout = new Set(sites.filter((_, i) => i % 4 === 3));
  if (holdout.size === 0 && sites.length > 1) holdout.add(sites[sites.length - 1] as string);

  const toExample = (r: LabelRow): TrainingExample => ({ text: r.text, label: r.label as 0 | 1 });

  // Cap negatives. Deterministic stride rather than random sampling, so a retrain produces
  // the same model and a weights diff stays reviewable.
  const capNegatives = (list: LabelRow[]): LabelRow[] => {
    const pos = list.filter((r) => r.label === 1);
    const neg = list.filter((r) => r.label === 0);
    const want = Math.max(pos.length * NEG_PER_POS, 40);
    if (neg.length <= want) return list;
    const stride = neg.length / want;
    const kept = [];
    for (let k = 0; k < want; k++) kept.push(neg[Math.floor(k * stride)] as LabelRow);
    return [...pos, ...kept];
  };

  const trainRows = capNegatives(rows.filter((r) => !holdout.has(r.site ?? "?")));
  const testRows = capNegatives(rows.filter((r) => holdout.has(r.site ?? "?")));

  if (testRows.length < 20 || testRows.every((r) => r.label === 0)) {
    line(
      "SKIPPED",
      `held-out set is unusable (${testRows.length} rows from ${holdout.size} site(s))`,
    );
    continue;
  }

  const model = train(patternId, trainRows.map(toExample));

  /**
   * Pick the decision threshold on the TRAINING set, then measure at it on the held-out one.
   *
   * 0.5 is the right default for balanced data and the wrong one here: with negatives
   * outnumbering positives four to one, a well-calibrated model puts most true positives
   * below 0.5 and the first run reported recall of 0.11, 0.22 and 0.00 while precision was
   * 0.80 to 1.00. That is not a model that cannot tell them apart, it is a model being read
   * at the wrong operating point.
   *
   * Tuned on training data specifically, never on the holdout. Sweeping thresholds against
   * the test set and reporting the best one is how a model that generalises badly comes to
   * look excellent, and this project has enough ways to fool itself already.
   */
  const trainExamples = trainRows.map(toExample);
  let bestThreshold = 0.5;
  let bestF1 = -1;
  for (let t = 0.05; t <= 0.95; t += 0.05) {
    const m = evaluate(model, trainExamples, t);
    const f1 =
      m.precision + m.recall > 0 ? (2 * m.precision * m.recall) / (m.precision + m.recall) : 0;
    if (f1 > bestF1) {
      bestF1 = f1;
      bestThreshold = Number(t.toFixed(2));
    }
  }

  const metrics = evaluate(model, testRows.map(toExample), bestThreshold);
  const heldOutPositives = testRows.filter((r) => r.label === 1).length;

  /**
   * A rate over a handful of positives is not a rate.
   *
   * The first run that produced a model reported held-out precision and recall of 1.00 for
   * social_proof, which is the sort of number that should provoke suspicion rather than
   * satisfaction, with few enough held-out positives, a model that memorised one string
   * template scores perfectly and has learned nothing. Refusing here is cheaper than
   * discovering it after shipping.
   */
  const MIN_HELDOUT_POSITIVES = 8;
  if (heldOutPositives < MIN_HELDOUT_POSITIVES) {
    line(
      "SKIPPED",
      `only ${heldOutPositives} held-out positive(s), any precision figure over that many ` +
        "is noise, whatever it says",
    );
    continue;
  }

  if (metrics.precision < MIN_PRECISION || metrics.recall < MIN_RECALL) {
    line(
      "REJECTED",
      `held-out P ${metrics.precision.toFixed(2)} R ${metrics.recall.toFixed(2)} ` +
        `over ${heldOutPositives} positive(s) @t=${bestThreshold} ` +
        `(need ${MIN_PRECISION}/${MIN_RECALL})`,
    );
    continue;
  }

  // The threshold travels WITH the weights. A model shipped without its operating point is
  // one the caller has to guess at, and the guess will be 0.5, which is the value that just
  // made three working models look broken.
  models[patternId] = { ...model, threshold: bestThreshold } as ClassifierModel & {
    threshold: number;
  };
  line(
    "OK",
    `held-out P ${metrics.precision.toFixed(2)} R ${metrics.recall.toFixed(2)} ` +
      `over ${heldOutPositives} positive(s) @t=${bestThreshold}`,
  );
}

console.log(`\n  pattern                       pos  neg   verdict    detail`);
console.log(`  ${"-".repeat(92)}`);
console.log(report.join("\n"));

if (unnamed.size > 0) {
  console.log(`\n  Techniques named that the taxonomy does not have:`);
  for (const [name, { count, examples }] of [...unnamed.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    console.log(`    ${String(count).padStart(3)}x  ${name}`);
    for (const e of examples) console.log(`          ${JSON.stringify(e)}`);
  }
  console.log(
    `\n  These are not trained, there is no detector to train. They are the argument for\n` +
      `  adding one, which is a deliberate decision rather than something this script makes.`,
  );
}

if (novelty.length > 0) {
  console.log(`\n  Does a model buy anything the regexes do not?`);
  console.log(novelty.join("\n"));
  console.log(
    `\n  A pattern whose positives are ALL lexicon matches has learned the lexicon in a more\n` +
      `  expensive form. The number that matters is the left one.`,
  );
}

const kept = Object.keys(models).length;
if (kept === 0) {
  console.log(`\n  Nothing qualified. No weights written, a partially trained model scoring`);
  console.log(`  real pages would be worse than the lexicons it replaces.\n`);
  process.exit(0);
}

mkdirSync(resolve("corpus"), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(models, null, 2)}\n`);
console.log(`\n  ${kept} model(s) -> ${OUT}`);
console.log(`  These are NOT in the extension yet. Wiring them in is a separate, deliberate step:`);
console.log(`  the card quotes the text that triggered it, and a model score is not a quote.\n`);
