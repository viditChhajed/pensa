/**
 * Export the corpus in chunks for automated labelling.
 *
 *   node scripts/export-for-labelling.mjs [--chunks 6] [--per-site 120]
 *
 * Deliberately NOT the tiered queue that `npm run label` serves. Those tiers — lexicon
 * matches, vocabulary near-misses, hard negatives — exist to spend a HUMAN's attention where
 * it is worth most, and they cap the set at what a person will finish. They also inherit the
 * loose regexes' blind spots, which is fatal here: the whole reason to widen the labelling is
 * to find positives the lexicons never recruited.
 *
 * So this exports every message-shaped snippet and asks the labeller to say which pattern
 * each one is, if any. One judgement per snippet rather than six.
 *
 * Stratified by site, because ebay alone contributes 554 and a model trained on it would
 * learn eBay's house style rather than the technique.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);
const CHUNKS = Number(args.chunks ?? 6);
const PER_SITE = Number(args["per-site"] ?? 120);

const CORPUS = resolve("corpus/candidates.jsonl");
const OUT_DIR = resolve("corpus/batches");

/**
 * Does this read like something said to the shopper, rather than a name or a label?
 *
 * Same test the human queue uses, and for the same reason: "Camp Chairs" and
 * "@user's instagram image of …" are not messages, and a labeller — person or model — asked
 * whether a perfume name is a scarcity claim learns the task is arbitrary.
 */
function looksLikeAMessage(text) {
  if (/'s (?:instagram|tiktok) (?:image|photo|video)/i.test(text)) return false;
  if (/^[A-Z][a-z]+:\s/.test(text) && text.length < 32) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  const saysSomething =
    /[.!?]/.test(text) ||
    /\b(?:is|are|was|were|has|have|get|save|only|left|ends?|now|you|your|we|our|hurry|shop|add|spend|pay|join|sold|order|ship|free|off)\b/i.test(
      text,
    );
  if (capitalised / words.length > 0.6 && !saysSomething) return false;
  return true;
}

const rows = readFileSync(CORPUS, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.text.length <= 180 && looksLikeAMessage(r.text));

// Cap per site. eBay contributes 554 of 4291 on its own, and a model trained on that learns
// eBay's house style rather than the technique.
const perSite = new Map();
const kept = [];
for (const r of rows) {
  const n = perSite.get(r.site) ?? 0;
  if (n >= PER_SITE) continue;
  perSite.set(r.site, n + 1);
  kept.push({ i: kept.length, text: r.text, site: r.site, key: r.key });
}

// Round-robin into chunks so every chunk sees every site. Contiguous slices would give one
// labeller nothing but eBay, and any systematic difference between labellers would then be
// indistinguishable from a difference between shops.
mkdirSync(OUT_DIR, { recursive: true });
const chunks = Array.from({ length: CHUNKS }, () => []);
kept.forEach((item, n) => chunks[n % CHUNKS].push(item));

for (const [n, chunk] of chunks.entries()) {
  writeFileSync(join(OUT_DIR, `batch-${n + 1}.json`), `${JSON.stringify(chunk, null, 1)}\n`);
}

console.log(
  `${kept.length} snippets from ${perSite.size} sites -> ${CHUNKS} batches in ${OUT_DIR}`,
);
for (const [n, chunk] of chunks.entries()) console.log(`  batch-${n + 1}.json  ${chunk.length}`);
