/**
 * scarcity.stock
 *
 * The negative case matters more than the positive one here. "2 sizes left" and "2 colors
 * left" are genuine variant availability, not a scarcity cue, and firing on them is exactly
 * the false positive that makes someone uninstall. They are excluded explicitly, and there
 * is a fixture for it.
 */

import type { DetectionCandidate } from "@/shared/schema";
import type { Detector, PageContext } from "../types";
import { candidate, matchLexemes, visibleCandidates } from "./util";

/**
 * Inventory nouns that may sit between the count and "left".
 *
 * Booking.com says "Only 3 rooms left at this price", not "Only 3 left" — measured, and it
 * scored zero. Enumerated rather than accepting any word, because `\w+` here would swallow
 * "only 3 sizes left", which is a catalogue fact rather than manufactured urgency and is the
 * exact false positive the plan warns causes uninstalls. Variant nouns stay excluded below.
 */
const UNIT_NOUN =
  "(?:rooms?|tickets?|seats?|items?|units?|pieces?|spots?|places?|nights?|copies|copy|boxes|packs?|bottles?|sets?)";

const STOCK_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\bonly (\\d{1,3}) (?:${UNIT_NOUN} )?(?:left|remaining|available)\\b`),
  new RegExp(`\\b(\\d{1,3}) ${UNIT_NOUN} (?:left|remaining|available)\\b`),
  /\b(\d{1,3}) (?:left|remaining) in stock\b/,
  /\bonly (\d{1,3}) in stock\b/,
  /\b(\d{1,3}) items? left\b/,
  /\blow stock\b/,
  /\balmost (?:gone|sold out)\b/,
  /\bselling fast\b/,
  /\bgoing fast\b/,
  /\bhurry,? only\b/,
  /\bwhile supplies last\b/,
  /\blimited quantity\b/,
];

/**
 * Genuine variant availability. A page saying "2 sizes left" is describing its catalogue,
 * not manufacturing urgency.
 */
const VARIANT_EXCLUSIONS: readonly RegExp[] = [
  /\b\d{1,3} (?:sizes?|colou?rs?|styles?|variants?|options?|shades?|widths?|lengths?) (?:left|remaining|available)\b/,
  /\b(?:size|colou?r|style) .{0,20}(?:out of stock|unavailable|sold out)\b/,
];

const LEXEMES = [
  "only",
  "left",
  "in stock",
  "low stock",
  "almost gone",
  "selling fast",
  "while supplies last",
  "limited quantity",
] as const;

const WEIGHTS: Record<string, number> = {
  numericStock: 0.5,
  qualitativeStock: 0.3,
  progressBar: 0.2,
  shortText: 0.1,
};

export const scarcityDetector: Detector = {
  id: "scarcity.stock@1",
  patternId: "scarcity.stock",
  stages: ["pdp", "cart", "browse"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];
    const seen = new Set<string>();

    for (const n of visibleCandidates(ctx)) {
      const t = n.normalizedText;
      if (t.length === 0 || t.length > 160) continue;

      if (VARIANT_EXCLUSIONS.some((re) => re.test(t))) continue;

      let numeric = 0;
      let qualitative = 0;
      for (const re of STOCK_PATTERNS) {
        const m = re.exec(t);
        if (!m) continue;
        if (m[1] !== undefined) numeric = 1;
        else qualitative = 1;
      }
      if (numeric === 0 && qualitative === 0) continue;
      if (seen.has(n.selectorPath)) continue;
      seen.add(n.selectorPath);

      // A stock bar rendered near the copy: role=progressbar, or a percent-width child.
      const progressBar = n.childIdxs.some((i) => {
        const c = ctx.candidates[i];
        return c?.role === "progressbar" || c?.attrs.role === "progressbar";
      })
        ? 1
        : 0;

      out.push(
        candidate(
          scarcityDetector.id,
          "scarcity.stock",
          n,
          {
            numericStock: numeric,
            qualitativeStock: qualitative,
            progressBar,
            shortText: t.length < 60 ? 1 : 0,
          },
          WEIGHTS,
          matchLexemes(n, LEXEMES),
        ),
      );
    }

    return out;
  },
};
