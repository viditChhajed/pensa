/**
 * Fold sharded crawl output back into one corpus, deduped.
 *
 *   node scripts/merge-corpus.mjs
 *
 * Each parallel crawler owns its own file because the dedup set lives in memory per process:
 * two of them appending to one file would each believe they had seen only their own lines.
 * Deduplication therefore has to happen here, once, across everything, on the same
 * digit-normalised key the crawler uses, so "Only 3 left" and "Only 7 left" collapse exactly
 * as they would have in a single-process run.
 */
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve("corpus");
const MAIN = join(DIR, "candidates.jsonl");

const seen = new Set();
const out = [];
let read = 0;

// The main file first, so an existing corpus keeps priority and shard output only adds.
const files = [
  "candidates.jsonl",
  ...readdirSync(DIR)
    .filter((f) => /^shard-\d+\.jsonl$/.test(f))
    .sort(),
];

for (const file of files) {
  let text;
  try {
    text = readFileSync(join(DIR, file), "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    read++;
    if (!row.key || seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(line);
  }
}

renameSync(MAIN, `${MAIN}.bak`);
writeFileSync(MAIN, `${out.join("\n")}\n`);
console.log(`  ${read} rows across ${files.length} file(s) -> ${out.length} unique`);
console.log(`  previous corpus kept at ${MAIN}.bak`);
