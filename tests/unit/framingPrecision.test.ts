import { describe, expect, it } from "vitest";
import { DETECTORS } from "@/content/detectors";
import { applyStrike, contextFrom } from "./helpers";

/**
 * Everything framing.savings_ratio claimed in the live precision audit of 22 retailers.
 *
 * Nineteen firings. Every one of them wrong — which is four more than the adjudication
 * counted, because three of the four it passed were wrong for reasons the quoted text does
 * not show. They are in here as negatives with the arithmetic written out, so nobody has to
 * re-derive it to know why they are not positives.
 *
 * Two things about the fixtures, both of which limit what this file can prove:
 *
 *   The quotes in `corpus/adjudication.md` are 60-character truncations of a console line,
 *   so the container that actually scored is not recoverable. Each case below therefore
 *   appears twice: verbatim as quoted, and inside a RECONSTRUCTED container built to the
 *   shape the audit describes — a grid row holding two products. Every reconstruction was
 *   checked to fire on the pre-fix detector before it was written down; a fixture that does
 *   not fire on the old code proves nothing about the new code.
 *
 *   The reconstructions are mine, not the sites'. They reproduce the MECHANISM the audit
 *   found (two products' prices in one container, plus a stray "off" or "save") and not the
 *   sites' exact markup. A green run here is evidence the mechanism is closed, not evidence
 *   that Zappos is quiet. Only `npm run spot:check` can say that.
 */

const LOG_THRESHOLD = 0.35;

function framingScore(text: string, stage: "pdp" | "browse" | "cart"): number {
  // One span per word, the way a tile's title and price actually reach `containerText`.
  const html = `<div class="row">${text
    .split(" ")
    .map((w) => `<span>${w}</span>`)
    .join(" ")}</div>`;
  const ctx = contextFrom(html, { stage, patch: applyStrike });
  return Math.max(
    0,
    ...DETECTORS.flatMap((d) => d.run(ctx))
      .filter((h) => h.patternId === "framing.savings_ratio")
      .map((h) => h.rawScore),
  );
}

/** [audit quote, reconstructed container, stage] */
type Case = [string, string, "pdp" | "browse" | "cart"];

/**
 * The eight Zappos firings.
 *
 * All eight are the same bug: `ABSOLUTE_CLAIM` was `/\b(?:save|you save|off)\b/`, and the
 * colourway "Off White" satisfies `\boff\b`. The detector then took the max and the min
 * price in the container — two different shoes — and reported the difference as a discount.
 */
const ZAPPOS: Case[] = [
  [
    "brand name new balance product name 370 gender unisex color",
    "brand name new balance product name 370 gender unisex color off white/white price $89.95 brand name hoka product name bondi 9 gender women's color rose gold price $220.00",
    "pdp",
  ],
  [
    "brand name new balance product name 237v1 gender women's col",
    "brand name new balance product name 237v1 gender women's color off white price $84.99 brand name hoka product name arahi 8 gender women's color steel price $245.00",
    "pdp",
  ],
  [
    "brand name new balance product name wl574v2 gender women's c",
    "brand name hoka product name clifton 10 gender women's color off white price $245.00 brand name new balance product name wl574v2 gender women's color sea salt price $89.95",
    "pdp",
  ],
  [
    "brand name hoka product name clifton 10 gender women's color",
    "brand name hoka product name clifton 10 gender women's color off white price $145.00 brand name asics product name gel-kayano 31 gender women's price $210.00",
    "pdp",
  ],
  [
    "brand name hoka product name bondi 9 gender women's color ro",
    "brand name hoka product name bondi 9 gender women's color rose gold price $165.00 brand name on product name cloudmonster gender women's color off white price $229.99",
    "pdp",
  ],
  [
    "brand name hoka product name arahi 8 gender women's color st",
    "brand name hoka product name arahi 8 gender women's color steel price $145.00 brand name saucony product name triumph 22 gender women's color off white price $238.00",
    "pdp",
  ],
  [
    "brand name nike product name v5 runner gender men's color of",
    "brand name nike product name v5 runner gender men's color off noir price $89.95 brand name nike product name vomero 18 gender men's price $234.99",
    "pdp",
  ],
  [
    "brand name new balance product name 603 gender women's color",
    "brand name new balance product name 603 gender women's color off white price $74.95 brand name brooks product name ghost max 2 gender women's price $215.00",
    "pdp",
  ],
];

/**
 * The seven Newegg firings.
 *
 * Here the stray claim word is real — a neighbouring tile genuinely says "Save $20" — which
 * is the harder version of the same mistake. A claim belongs to ONE product; sharing a grid
 * row with it is not evidence that it describes yours.
 */
const NEWEGG: Case[] = [
  [
    "gmktec evo-x2 ai mini pc ryzen al max+ 395 (up to 5.1ghz) mi",
    "gmktec evo-x2 ai mini pc ryzen al max+ 395 (up to 5.1ghz) mini pc $1,699.99 save $200 msi gaming desktop pc aegis rs2 $2,499.99",
    "browse",
  ],
  [
    "quick view (2)sid meier's civilization vi xbox one [digital ",
    "quick view (2)sid meier's civilization vi xbox one [digital code] $239.99 quick view crime boss: rockay city - pc $9.99 save $20",
    "browse",
  ],
  [
    "quick view crime boss: rockay city - pc [steam online game c",
    "quick view crime boss: rockay city - pc [steam online game code] $9.99 quick view assassin's creed shadows $249.99 save $50",
    "browse",
  ],
  [
    "quick view crime boss: rockay city - pc digital [epic games]",
    "quick view crime boss: rockay city - pc digital [epic games] $8.99 quick view starfield premium $229.99 save $40",
    "browse",
  ],
  [
    "agi 2tb ssd, ai828 pcie nvme 4.0 m.2 2280 gen4x4 with heat s",
    "agi 2tb ssd, ai828 pcie nvme 4.0 m.2 2280 gen4x4 with heat sink $209.00 kingsman ke680 m.2 2280 2tb internal solid state drive $99.99 save $40",
    "browse",
  ],
  [
    "agi 1tb ssd, ai828 pcie nvme 4.0 m.2 2280 gen4x4 with heat s",
    "agi 1tb ssd, ai828 pcie nvme 4.0 m.2 2280 gen4x4 with heat sink $99.99 save $30 samsung 990 pro 4tb nvme ssd $289.99",
    "browse",
  ],
  [
    "(10) kingsman ke680 m.2 2280 nvme pcie gen4x 4 2tb internal ",
    "(10) kingsman ke680 m.2 2280 nvme pcie gen4x 4 2tb internal solid state drive $210.00 crucial p3 plus 1tb pcie gen4 ssd $69.99 save $20",
    "browse",
  ],
];

/**
 * The Ulta firing, which the adjudication flagged for a second look and was right to.
 *
 * It is tagged [percent-framing] rather than [absolute-framing], so it is not the `\boff\b`
 * bug — but it is the same pairing error wearing a percent badge: a recommendations carousel
 * under the PDP, one tile's price against another tile's, with a third tile's "% off".
 */
const ULTA: Case[] = [
  [
    "la roche-posay toleriane purifying foaming face wash for oil",
    "la roche-posay toleriane purifying foaming face wash for oily skin $16.99 20% off elf halo glow liquid filter $14.00",
    "pdp",
  ],
];

describe("framing does not read a product grid as a discount", () => {
  for (const [quote, container, stage] of [...ZAPPOS, ...NEWEGG, ...ULTA]) {
    it(`stays silent on ${JSON.stringify(quote)}`, () => {
      expect(framingScore(quote, stage), "the quoted text alone").toBeLessThan(LOG_THRESHOLD);
      expect(framingScore(container, stage), "the reconstructed grid row").toBeLessThan(
        LOG_THRESHOLD,
      );
    });
  }
});

describe("the three firings the audit passed were not correct either", () => {
  /**
   * Shown as "Save 27%". As an amount the same discount is $1,350.00.
   *
   * The Rule of 100 says the flattering framing on a $4,999 item is the dollar amount, and
   * this page chose the percentage — the SMALLER-looking number. By the detector's own
   * premise there is nothing here to flag.
   *
   * It fired anyway because `PERCENT_CLAIM` required a word after the "%" ("27% off"), so
   * "save 27%" fell through to `ABSOLUTE_CLAIM`'s bare `\bsave\b` and was scored, and
   * labelled, as absolute framing. Same class of bug as the colourway: a regex that reads a
   * word and calls it a claim.
   */
  it("does not fire on a percentage that under-sells the discount", () => {
    expect(framingScore("$4,999.99 $3,649.99 save 27%", "browse")).toBeLessThan(LOG_THRESHOLD);
  });

  /**
   * Both SHEIN firings were arithmetic on numbers that do not exist.
   *
   * SHEIN glues price and badge into one text node, and `parsePrices` reads the run
   * "$3.6010% off" as $3,601.00 and "$184.0074% off" as $184,007.00 — the grouped branch of
   * the price regex takes the "601" after the dot as a thousands group. So the "27% saving"
   * the audit passed was computed between $184,007.00 and $10,393.00.
   *
   * That is a money.ts bug, not a framing one, and it is NOT fixed here — fixing the price
   * regex touches drip reconciliation and deserves its own change. What this file can do is
   * record that these two firings were never evidence of anything, so that fixing the parser
   * later is not mistaken for a recall regression here.
   */
  it("does not fire on SHEIN's glued price-and-badge runs", () => {
    expect(framingScore("$12.99flash sale$3.6010% off", "browse")).toBeLessThan(LOG_THRESHOLD);
    expect(framingScore("apple$184.0074% offprettygarden$10.3932% off", "browse")).toBeLessThan(
      LOG_THRESHOLD,
    );
  });
});

describe("framing still fires when a discount is actually claimed", () => {
  /**
   * The detector is worth keeping only if it still sees the thing it is for. These are the
   * two textbook shapes — a cheap item framed as a percentage, an expensive one framed as an
   * amount — written the way a retailer writes them: the reference price first, the live
   * price next to it, and the claim naming its own number.
   */
  it("fires on a percentage that flatters a small saving", () => {
    // $12.00 -> $9.00 is $3.00 off, or 25%. The percentage is the bigger-looking number.
    expect(framingScore("$12.00 $9.00 25% off", "pdp")).toBeGreaterThanOrEqual(LOG_THRESHOLD);
  });

  it("fires on an amount that flatters a modest percentage", () => {
    // $399.99 -> $249.99 is 37.5%, or $150.00. The amount is the bigger-looking number.
    expect(
      framingScore("sony wh-1000xm5 was $399.99 now $249.99 save $150.00", "pdp"),
    ).toBeGreaterThanOrEqual(LOG_THRESHOLD);
  });

  it("fires on a struck reference price beside its markdown", () => {
    const ctx = contextFrom(
      `<div class="price"><span class="was"><s>$19.99</s></span><span class="now">$4.99</span>` +
        `<span class="badge">75% off</span></div>`,
      { stage: "pdp", patch: applyStrike },
    );
    const hits = DETECTORS.flatMap((d) => d.run(ctx)).filter(
      (h) => h.patternId === "framing.savings_ratio",
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.subSignals.referencePrice, "a struck price should corroborate the pair").toBe(
      1,
    );
  });

  it("does not pair the claim's own figure with the reference price", () => {
    // "$1,699.99 save $200" is not a was/now pair, and reading it as one invents an 88%
    // discount. This is the shape the first draft of this fix still fired on.
    expect(framingScore("gmktec evo-x2 mini pc $1,699.99 save $200", "browse")).toBeLessThan(
      LOG_THRESHOLD,
    );
  });
});
