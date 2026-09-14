/**
 * Merge automated batch labels into corpus/labels.jsonl.
 *
 *   node scripts/ingest-auto-labels.mjs
 *
 * Every row is stamped `source: "auto"`, and that is not bookkeeping. Labels produced by a
 * model are legitimate TRAINING data — the text is real, collected from 36 real shops, and
 * judging real sentences is a different act from inventing them, which is what produced the
 * lexicon misses in the first place.
 *
 * They are NOT independent validation. A classifier trained on them learns a compression of
 * one judgement, and if that judgement is wrong in some systematic way the model will be
 * wrong the same way and will agree with itself confidently. So nothing in EVAL.md may cite
 * these as a precision result, and `npm run label` still exists for the human spot-check that
 * can actually measure the error rate.
 *
 * Human rows always win: an existing hand label is never overwritten by an automated one.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TRAINABLE } from "./label-queue.mjs";

const BATCH_DIR = resolve("corpus/batches");
const AUTO_DIR = resolve("corpus/auto");
const LABELS = resolve("corpus/labels.jsonl");

const VALID = new Set(TRAINABLE.map((p) => p.id));

/** Existing hand labels, keyed as the trainer keys them. Never overwritten. */
const human = new Map();
if (existsSync(LABELS)) {
  for (const line of readFileSync(LABELS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.source === "auto") continue;
      const id = `${r.patternId}|${r.key}`;
      if (r.undo) human.delete(id);
      else human.set(id, r);
    } catch {
      /* a truncated last line is not worth losing the file over */
    }
  }
}

const out = [];
const unnamed = new Map();
let items = 0;
let unsure = 0;
let positives = 0;
const missing = [];

for (const file of readdirSync(BATCH_DIR).sort()) {
  if (!file.endsWith(".json")) continue;
  const n = file.replace(/^batch-|\.json$/g, "");
  const answersPath = join(AUTO_DIR, `batch-${n}.jsonl`);
  if (!existsSync(answersPath)) {
    missing.push(`batch-${n}`);
    continue;
  }

  const batch = JSON.parse(readFileSync(join(BATCH_DIR, file), "utf8"));
  const answers = new Map();
  for (const line of readFileSync(answersPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line);
      answers.set(a.i, a);
    } catch {
      /* one malformed line loses one item, never the batch */
    }
  }

  for (const item of batch) {
    const a = answers.get(item.i);
    // An item the labeller skipped is NOT a negative. Treating a missing answer as "no"
    // would silently manufacture thousands of negatives out of a truncated file.
    if (!a) continue;
    items++;
    if (a.u) {
      unsure++;
      continue;
    }

    const matched = (a.p ?? []).filter((p) => VALID.has(p));
    if (a.other) {
      const name = String(a.other).trim().toLowerCase().slice(0, 60);
      const entry = unnamed.get(name) ?? { count: 0, examples: [] };
      entry.count++;
      if (entry.examples.length < 4) entry.examples.push(item.text.slice(0, 74));
      unnamed.set(name, entry);
    }

    /**
     * One row per PATTERN, not per item. A snippet the labeller matched to nothing is a
     * negative for all six, and those negatives are most of the value: they are what teaches
     * a classifier that "no" is the usual answer and what a near-miss looks like.
     */
    for (const patternId of VALID) {
      if (human.has(`${patternId}|${item.key}`)) continue;
      const label = matched.includes(patternId) ? 1 : 0;
      if (label === 1) positives++;
      out.push({
        patternId,
        key: item.key,
        text: item.text,
        site: item.site,
        label,
        source: "auto",
        ts: Date.now(),
      });
    }
  }
}

if (missing.length > 0) {
  console.error(`\n  No answers found for: ${missing.join(", ")}`);
  console.error(`  Those batches are skipped rather than counted as all-negative.\n`);
}

// Human rows first so a later reader sees them win, then the automated ones.
const merged = [...human.values(), ...out];
writeFileSync(
  LABELS,
  merged.map((r) => JSON.stringify(r)).join("\n") + (merged.length ? "\n" : ""),
);

console.log(`\n  ${items} items labelled, ${unsure} marked unsure and skipped.`);
console.log(`  ${positives} positive labels across ${VALID.size} patterns.`);
console.log(`  ${human.size} existing hand label(s) preserved.`);
console.log(`  -> ${LABELS} (${merged.length} rows)`);

if (unnamed.size > 0) {
  console.log(`\n  Techniques named that the taxonomy does not have:`);
  for (const [name, e] of [...unnamed.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)) {
    console.log(`    ${String(e.count).padStart(4)}x  ${name}`);
    for (const ex of e.examples.slice(0, 2)) console.log(`           ${JSON.stringify(ex)}`);
  }
}
