/**
 * Group a spot-check run into one readable block per distinct claim.
 *
 * The audit writes one JSON row per claim, which is the right shape for counting and the
 * wrong shape for reading: adjudicating 200 claims means asking "did that page really show
 * this?" 200 times, and the answer depends almost entirely on the matched text. So this
 * collapses the rows to patternId -> evidence -> where it was seen, which is the order a
 * person actually reads them in.
 *
 *   node scripts/adjudicate-prep.mjs corpus/spot-s*.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";

const files = process.argv.slice(2);
const rows = [];
for (const f of files) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
}

// Deduped across shards too: the same claim can legitimately appear on two sites, and that
// is two claims, but the same claim on the same path is one however many shards saw it.
const distinct = new Map();
for (const r of rows) {
  const key = `${r.patternId}|${r.evidence}|${r.site}|${new URL(r.url).pathname}`;
  const prev = distinct.get(key);
  if (prev) prev.loggedTimes += r.loggedTimes ?? 1;
  else distinct.set(key, { ...r });
}

const byPattern = new Map();
for (const r of distinct.values()) {
  if (!byPattern.has(r.patternId)) byPattern.set(r.patternId, []);
  byPattern.get(r.patternId).push(r);
}

const out = [];
let total = 0;
for (const [patternId, claims] of [...byPattern.entries()].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  out.push(`\n## ${patternId} — ${claims.length} claim(s)\n`);
  for (const c of claims.sort((a, b) => a.site.localeCompare(b.site))) {
    total++;
    out.push(
      `${String(total).padStart(3)}. [${c.site} ${c.stage}] ${JSON.stringify(c.evidence)}  (${c.loggedTimes}x)  ${new URL(c.url).pathname.slice(0, 70)}`,
    );
  }
}
const text = `${total} distinct claim(s) across ${new Set([...distinct.values()].map((r) => r.site)).size} site(s)\n${out.join("\n")}\n`;
writeFileSync("corpus/adjudication.md", text);
console.log(text);
