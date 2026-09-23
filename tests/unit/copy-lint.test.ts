import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPTS, pickPrompt } from "@/shared/copy/prompts";
import { type PatternId, TAXONOMY } from "@/shared/taxonomy";

/**
 * CI enforcement of the §9 copy rules.
 *
 * This is not stylistic pedantry. "Observe and question, never accuse" is simultaneously the
 * ethical position, the legal position (the extension makes no claim about whether any
 * scarcity message is truthful), and the store-review position. A single sentence asserting
 * that a merchant is deceiving someone would undermine all three, so the constraint is
 * enforced by a test rather than by remembering.
 */

/** Asserting intent, falsity, or wrongdoing. Never acceptable in user-facing copy. */
const BANNED = [
  "scam",
  "trick",
  "tricked",
  "deceptive",
  "deceive",
  "fake",
  "manipulat",
  "lying",
  "lie",
  "illegal",
  "predatory",
  "dishonest",
  "fraud",
  "exploit",
  "shady",
  "dark pattern",
];

/** Telling the user what to do rather than asking. */
const IMPERATIVE_OPENERS = [
  "don't",
  "do not",
  "stop",
  "avoid",
  "never",
  "beware",
  "watch out",
  "consider",
  "remember to",
  "make sure",
  "you should",
  "you shouldn't",
];

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Flesch-Kincaid grade level. Target is grade 8; 10 is the hard ceiling. */
function gradeLevel(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  const sentenceCount = Math.max(1, sentences(text).length);
  const syllableCount = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentenceCount) + 11.8 * (syllableCount / words.length) - 15.59;
}

const ALL: { patternId: PatternId; prompt: string }[] = Object.entries(PROMPTS).flatMap(
  ([patternId, pool]) =>
    (pool ?? []).map((prompt) => ({ patternId: patternId as PatternId, prompt })),
);

describe("prompt copy", () => {
  it("has prompts to lint", () => {
    expect(ALL.length).toBeGreaterThan(40);
  });

  it("every prompt ends in a question", () => {
    for (const { patternId, prompt } of ALL) {
      expect(prompt.endsWith("?"), `${patternId}: ${prompt}`).toBe(true);
    }
  });

  it("no prompt contains a banned word", () => {
    for (const { patternId, prompt } of ALL) {
      const lower = prompt.toLowerCase();
      for (const word of BANNED) {
        expect(lower.includes(word), `${patternId} uses "${word}": ${prompt}`).toBe(false);
      }
    }
  });

  it("no prompt opens with an imperative", () => {
    for (const { patternId, prompt } of ALL) {
      const lower = prompt.toLowerCase();
      for (const opener of IMPERATIVE_OPENERS) {
        expect(lower.startsWith(opener), `${patternId} is imperative: ${prompt}`).toBe(false);
      }
    }
  });

  it("every prompt pairs an observation with a question", () => {
    // The first clause states what the page did; the last asks something.
    for (const { patternId, prompt } of ALL) {
      const parts = sentences(prompt);
      expect(
        parts.length,
        `${patternId} needs observation + question: ${prompt}`,
      ).toBeGreaterThanOrEqual(2);
      expect(parts[0]?.endsWith("?"), `${patternId} opens with a question: ${prompt}`).toBe(false);
    }
  });

  it("reads at roughly grade 8", () => {
    for (const { patternId, prompt } of ALL) {
      const grade = gradeLevel(prompt);
      expect(grade, `${patternId} grade ${grade.toFixed(1)}: ${prompt}`).toBeLessThan(10);
    }
  });

  it("gives every pattern 4-6 variants", () => {
    for (const [patternId, pool] of Object.entries(PROMPTS)) {
      expect(pool?.length, `${patternId}`).toBeGreaterThanOrEqual(4);
      expect(pool?.length, `${patternId}`).toBeLessThanOrEqual(6);
    }
  });

  it("has no duplicate strings within a pattern", () => {
    for (const [patternId, pool] of Object.entries(PROMPTS)) {
      expect(new Set(pool).size, `${patternId}`).toBe(pool?.length);
    }
  });

  it("only references patterns that exist in the taxonomy", () => {
    for (const patternId of Object.keys(PROMPTS)) {
      expect(TAXONOMY[patternId as PatternId], patternId).toBeDefined();
    }
  });
});

describe("pickPrompt", () => {
  it("prefers a variant not yet used this session", () => {
    const pool = PROMPTS["urgency.countdown"] ?? [];
    const used = new Set(pool.slice(0, pool.length - 1));
    expect(pickPrompt("urgency.countdown", used, () => 0)).toBe(pool[pool.length - 1]);
  });

  it("falls back to reuse rather than showing nothing", () => {
    const pool = PROMPTS["urgency.countdown"] ?? [];
    const result = pickPrompt("urgency.countdown", new Set(pool), () => 0);
    expect(pool).toContain(result);
  });

  it("returns null for a pattern with no pool", () => {
    expect(pickPrompt("review_integrity.unverified", new Set())).toBeNull();
  });

  it("never returns undefined for a max random value", () => {
    // Math.random() can return values that floor to length with FP rounding.
    expect(pickPrompt("scarcity.stock", new Set(), () => 0.9999999999)).not.toBeNull();
  });
});

/**
 * No em dashes, anywhere Pensa writes.
 *
 * A house style rule, asserted rather than remembered: they had spread through every file and
 * every piece of user-visible copy. The two exceptions are deliberate and narrow.
 */
describe("house style: no em dashes", () => {
  const ROOTS = ["src", "store/description.txt", "PRIVACY.md", "STORE-LISTING.md", "README.md"];

  /** An em dash inside a character class matches RETAILER text (a price range, a title separator). */
  const IN_CHARACTER_CLASS = /\[[^\]]*—[^\]]*\]/;

  function walk(p: string, out: string[] = []): string[] {
    const s = statSync(p);
    if (s.isDirectory()) {
      for (const e of readdirSync(p)) walk(join(p, e), out);
    } else if (/\.(ts|tsx|html|css|md|txt|mjs|js)$/.test(p)) {
      out.push(p);
    }
    return out;
  }

  it("has none in the extension or in published copy", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (!line.includes("—") || IN_CHARACTER_CLASS.test(line)) return;
            offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
          });
      }
    }
    expect(offenders, `em dash found:\n${offenders.join("\n")}`).toEqual([]);
  });
});
