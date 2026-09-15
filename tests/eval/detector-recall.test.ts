import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DETECTORS } from "@/content/detectors";
import { TRAINABLE } from "../../scripts/label-queue.mjs";
import { contextFrom } from "../unit/helpers";

/**
 * What the shipped detectors actually do on real copy.
 *
 * Every precision and recall number this project has had until now came from fixtures I
 * wrote, against lexicons I wrote, from the same imagination — so they agreed with each
 * other and with nothing else. EVAL run 1 named that as its top finding and there was no
 * instrument capable of measuring it.
 *
 * There is one now: 2,639 snippets from 36 real shops, labelled. This runs the REAL
 * detectors over them and reports precision and recall per pattern, at both the log and the
 * surface threshold.
 *
 * Two things this is NOT:
 *
 *   It is not a precision claim for EVAL.md. The labels were produced by a model, and a
 *   detector agreeing with a model's judgement is not the same as being right. It measures
 *   AGREEMENT, which is the useful quantity when the alternative is measuring nothing.
 *
 *   It is not a pass/fail gate on absolute numbers, which would need labels good enough to
 *   deserve one. It is a RATCHET: the baseline is recorded to disk, and a change that makes
 *   recall worse fails. That is the property worth having while the lexicons are being
 *   rewritten.
 */

const LABELS = resolve("corpus/labels.jsonl");
const BASELINE = resolve("tests/eval/baseline.json");

const LOG_THRESHOLD = 0.35;
const SURFACE_THRESHOLD = 0.75;

interface Row {
  patternId: string;
  text: string;
  label: 0 | 1;
  site?: string;
}

interface Scores {
  detected: number;
  surfaced: number;
  positives: number;
  negatives: number;
  truePosLog: number;
  falsePosLog: number;
  truePosSurface: number;
  falsePosSurface: number;
}

const available = existsSync(LABELS);

describe.skipIf(!available)("detectors against real labelled copy", () => {
  const rows: Row[] = readFileSync(LABELS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.label === 0 || r.label === 1);

  /**
   * Score every distinct snippet ONCE against every detector, rather than once per label row.
   *
   * The labels are one row per pattern per snippet — six rows for the same text — and running
   * a jsdom harvest six times over each of 2,639 snippets is 16,000 harvests for no extra
   * information.
   */
  const byText = new Map<string, Map<string, number>>();
  const texts = [...new Set(rows.map((r) => r.text))];

  for (const text of texts) {
    const ctx = contextFrom(`<div class="cart">${text}</div>`, { stage: "cart" });
    const best = new Map<string, number>();
    for (const detector of DETECTORS) {
      for (const hit of detector.run(ctx)) {
        const prev = best.get(hit.patternId) ?? 0;
        if (hit.rawScore > prev) best.set(hit.patternId, hit.rawScore);
      }
    }
    byText.set(text, best);
  }

  const results = new Map<string, Scores>();
  for (const pattern of TRAINABLE) {
    const s: Scores = {
      detected: 0,
      surfaced: 0,
      positives: 0,
      negatives: 0,
      truePosLog: 0,
      falsePosLog: 0,
      truePosSurface: 0,
      falsePosSurface: 0,
    };
    for (const row of rows.filter((r) => r.patternId === pattern.id)) {
      const score = byText.get(row.text)?.get(pattern.id) ?? 0;
      if (row.label === 1) s.positives++;
      else s.negatives++;
      if (score >= LOG_THRESHOLD) {
        s.detected++;
        if (row.label === 1) s.truePosLog++;
        else s.falsePosLog++;
      }
      if (score >= SURFACE_THRESHOLD) {
        s.surfaced++;
        if (row.label === 1) s.truePosSurface++;
        else s.falsePosSurface++;
      }
    }
    results.set(pattern.id, s);
  }

  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);

  it("reports agreement with the labelled corpus", () => {
    const lines: string[] = [];
    lines.push("");
    lines.push(
      "  pattern                        pos   recall@log  prec@log   recall@surf  prec@surf",
    );
    lines.push(`  ${"-".repeat(84)}`);

    for (const pattern of TRAINABLE) {
      const s = results.get(pattern.id) as Scores;
      lines.push(
        `  ${pattern.id.padEnd(30)} ${String(s.positives).padStart(4)}   ` +
          `${rate(s.truePosLog, s.positives).toFixed(2).padStart(10)}  ` +
          `${rate(s.truePosLog, s.truePosLog + s.falsePosLog)
            .toFixed(2)
            .padStart(8)}   ` +
          `${rate(s.truePosSurface, s.positives).toFixed(2).padStart(11)}  ` +
          `${rate(s.truePosSurface, s.truePosSurface + s.falsePosSurface)
            .toFixed(2)
            .padStart(9)}`,
      );
    }
    console.log(lines.join("\n"));

    // Always passes: the report is the deliverable. The ratchet below is what fails.
    expect(results.size).toBe(TRAINABLE.length);
  });

  it("does not lose recall it already had", () => {
    /**
     * A ratchet, not a bar.
     *
     * Absolute thresholds would need labels good enough to deserve one, and these are
     * model-produced. What they CAN support is "this change made it worse", which is exactly
     * the guard needed while the lexicons are rewritten against what the corpus revealed.
     *
     * A 0.02 tolerance absorbs the jitter from re-labelling; anything larger is a regression
     * and should be argued for rather than absorbed.
     */
    const recall: Record<string, number> = {};
    const positives: Record<string, number> = {};
    for (const pattern of TRAINABLE) {
      const s = results.get(pattern.id) as Scores;
      recall[pattern.id] = Number(rate(s.truePosLog, s.positives).toFixed(3));
      positives[pattern.id] = s.positives;
    }
    const current = { recall, positives };

    if (!existsSync(BASELINE)) {
      writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
      console.log(`\n  Baseline recorded at ${BASELINE}. Re-run to ratchet against it.`);
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as typeof current;

    /**
     * A recall rate is only comparable against the SAME labelled set.
     *
     * The corpus grew and the label file was rebuilt underneath a recorded baseline, and the
     * ratchet duly reported "recall fell: scarcity 0.64 -> 0.44, urgency 0.79 -> 0.48". No
     * detector had changed. The denominators had: fewer positives in the file meant a
     * different question was being asked, and the guard could not tell the difference
     * between a worse detector and a different corpus.
     *
     * A guard that cries regression when nothing regressed gets ignored, and then it is not
     * a guard. So the baseline records its positive counts, and a mismatch says re-baseline
     * rather than blaming the detectors.
     */
    const shifted = Object.entries(baseline.positives ?? {})
      .filter(([id, was]) => (positives[id] ?? 0) !== was)
      .map(([id, was]) => `${id}: ${was} -> ${positives[id] ?? 0} positives`);

    expect(
      shifted,
      "the LABEL SET changed, so these recall rates are not comparable:\n    " +
        `${shifted.join("\n    ")}\n` +
        "  This is not a detector regression. Re-record tests/eval/baseline.json against the " +
        "new labels, then compare.",
    ).toEqual([]);

    const regressions: string[] = [];
    for (const [id, was] of Object.entries(baseline.recall ?? {})) {
      const now = recall[id] ?? 0;
      if (now < was - 0.02) regressions.push(`${id}: ${was.toFixed(2)} -> ${now.toFixed(2)}`);
    }

    expect(
      regressions,
      `recall fell against the labelled corpus:\n    ${regressions.join("\n    ")}\n` +
        "  If this is intended, update tests/eval/baseline.json and say why in the commit.",
    ).toEqual([]);
  });

  it("names what it is still missing, so the next fix has somewhere to start", () => {
    const lines: string[] = [];
    for (const pattern of TRAINABLE) {
      const missed = rows
        .filter((r) => r.patternId === pattern.id && r.label === 1)
        .filter((r) => (byText.get(r.text)?.get(pattern.id) ?? 0) < LOG_THRESHOLD);
      if (missed.length === 0) continue;
      lines.push(
        `\n  ${pattern.id} — ${missed.length} positive(s) scoring below the log threshold:`,
      );
      for (const r of missed.slice(0, 6))
        lines.push(`      ${JSON.stringify(r.text.slice(0, 76))}`);
    }
    if (lines.length > 0) console.log(lines.join("\n"));
    expect(true).toBe(true);
  });
});
