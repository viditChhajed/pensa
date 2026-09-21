import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Ingesting a second time must not discard the first.
 *
 * This test exists because the script did exactly that. It kept only rows without
 * `source: "auto"` and rewrote the file from scratch, so a second run against a fresh set of
 * batches destroyed the entire previous automated pass — 2,639 labelled items and 201
 * positives, replaced by 59, with the source batches already cleared to make room for the
 * new export.
 *
 * "Preserve the valuable rows" was the intent; "preserve the human rows" was the code. Those
 * are the same thing only if automated labels are worthless, which is the opposite of why
 * the script exists. No review would have caught it — the behaviour is only visible on the
 * SECOND run, and the first run looked perfect.
 */

const ROOT = resolve(".");
let sandbox: string;
let cwd: string;

/** Run the real script against a throwaway corpus directory. */
function ingest(): string {
  execFileSync("node", [join(ROOT, "scripts/ingest-auto-labels.mjs")], { cwd, stdio: "pipe" });
  return readFileSync(join(cwd, "corpus/labels.jsonl"), "utf8");
}

function writeRound(n: number, key: string, patterns: string[]): void {
  rmSync(join(cwd, "corpus/batches"), { recursive: true, force: true });
  rmSync(join(cwd, "corpus/auto"), { recursive: true, force: true });
  mkdirSync(join(cwd, "corpus/batches"), { recursive: true });
  mkdirSync(join(cwd, "corpus/auto"), { recursive: true });
  writeFileSync(
    join(cwd, `corpus/batches/batch-${n}.json`),
    JSON.stringify([{ i: 0, text: `text for ${key}`, site: "example.com", key }]),
  );
  writeFileSync(
    join(cwd, `corpus/auto/batch-${n}.jsonl`),
    `${JSON.stringify({ i: 0, p: patterns })}\n`,
  );
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "pensa-ingest-"));
  cwd = sandbox;
  mkdirSync(join(cwd, "corpus"), { recursive: true });
  // The script resolves scripts/label-queue.mjs relative to itself, so only corpus/ matters.
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("ingest merges instead of replacing", () => {
  it("keeps the first round's labels when a second round runs", () => {
    writeRound(1, "first-key", ["scarcity.stock"]);
    const after1 = ingest();
    expect(after1).toContain("first-key");

    writeRound(2, "second-key", ["urgency.countdown"]);
    const after2 = ingest();

    expect(after2, "the second run discarded the first round").toContain("first-key");
    expect(after2).toContain("second-key");
  });

  it("keeps the first round's POSITIVES, not merely its rows", () => {
    // The row count alone would have looked fine: every snippet produces six rows whether it
    // matched anything or not. What was actually lost was the positives.
    const rows = readFileSync(join(cwd, "corpus/labels.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { key: string; patternId: string; label: number });

    const first = rows.find((r) => r.key === "first-key" && r.patternId === "scarcity.stock");
    expect(first?.label, "the first round's positive was lost").toBe(1);
  });

  it("never lets an automated label overwrite a hand label", () => {
    const labels = join(cwd, "corpus/labels.jsonl");
    writeFileSync(
      labels,
      `${JSON.stringify({ patternId: "scarcity.stock", key: "hand-key", text: "t", label: 1, source: "hand" })}\n`,
    );
    // An automated pass that disagrees about the same key.
    writeRound(3, "hand-key", []);
    const after = ingest();

    const row = after
      .split("\n")
      .filter(Boolean)
      .map(
        (l) => JSON.parse(l) as { key: string; patternId: string; label: number; source: string },
      )
      .find((r) => r.key === "hand-key" && r.patternId === "scarcity.stock");

    expect(row?.source, "a human judgement was overwritten by a model's").toBe("hand");
    expect(row?.label).toBe(1);
  });

  it("writes atomically, so a crash cannot truncate the file", () => {
    // Belt and braces after losing an afternoon of labelling: the script renames a temp file
    // into place rather than writing over the real one.
    const src = readFileSync(join(ROOT, "scripts/ingest-auto-labels.mjs"), "utf8");
    expect(src).toContain("renameSync");
    expect(existsSync(join(cwd, "corpus/labels.jsonl.tmp"))).toBe(false);
  });
});
