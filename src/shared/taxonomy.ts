/**
 * The bridge between the code and the policy write-up. Every detector references an entry
 * here, and the "learn more" expander renders `citation` verbatim.
 *
 * Deliberately absent: gambler's fallacy, hot-hand, and the sequential-judgment family.
 * They leave no DOM artifact, so a detector for them fires at ~0%. Also absent:
 * attribute framing (the "80% lean" family), a real effect, but it lives on CPG packaging
 * and nutrition panels rather than in checkout flows.
 */

export type Tier = 1 | 2 | 3;

export type PatternFamily =
  | "anchoring"
  | "pricing"
  | "scarcity"
  | "urgency"
  | "social_proof"
  | "defaults"
  | "confirmshaming"
  | "goal_gradient"
  | "interference"
  | "decoy"
  | "nagging"
  | "basket"
  | "framing"
  | "loss_aversion"
  | "temporal"
  | "reciprocity"
  | "authority"
  | "forced_continuity"
  | "review_integrity";

export interface TaxonomyEntry {
  readonly id: string;
  readonly family: PatternFamily;
  /** Shown in the UI. Neutral noun phrase, names the artifact, not an intent. */
  readonly label: string;
  /** One line, grade-8 reading level, describes the mechanism without accusing anyone. */
  readonly mechanism: string;
  /** Primary literature or regulatory source, rendered verbatim in "learn more". */
  readonly citation: string;
  /** 0..1. Editorial weighting for digest ranking only, not an empirical quantity. */
  readonly severityWeight: number;
  readonly tier: Tier;
  /** Needs the session ledger (cross-funnel-stage state). */
  readonly crossStage: boolean;
  /** Needs repeat observation across visits (§18A). No output on first sighting. */
  readonly temporal: boolean;
}

export const TAXONOMY = {
  // ------------------------------- Tier 1 -------------------------------
  "anchoring.reference_price": {
    id: "anchoring.reference_price",
    family: "anchoring",
    label: "Reference price",
    mechanism: "A higher crossed-out price sets the number you compare the real price against.",
    citation:
      "Tversky, A. & Kahneman, D. (1974). Judgment under Uncertainty: Heuristics and Biases. Science, 185(4157), 1124–1131.",
    severityWeight: 0.55,
    tier: 1,
    crossStage: false,
    temporal: false,
  },
  "pricing.charm": {
    id: "pricing.charm",
    family: "pricing",
    label: "Charm pricing",
    mechanism:
      "Prices ending in .99 are read from the left digit, so $9.99 feels closer to $9 than to $10.",
    citation:
      "Thomas, M. & Morwitz, V. (2005). Penny Wise and Pound Foolish: The Left-Digit Effect in Price Cognition. Journal of Consumer Research, 32(1), 54–64.",
    severityWeight: 0.2,
    tier: 1,
    crossStage: false,
    temporal: false,
  },
  "scarcity.stock": {
    id: "scarcity.stock",
    family: "scarcity",
    label: "Limited stock message",
    mechanism:
      "Things that seem rare are valued more highly than the same thing in plentiful supply.",
    citation:
      "Worchel, S., Lee, J. & Adewole, A. (1975). Effects of Supply and Demand on Ratings of Object Value. Journal of Personality and Social Psychology, 32(5), 906–914.",
    severityWeight: 0.65,
    tier: 1,
    crossStage: false,
    temporal: false,
  },
  "urgency.countdown": {
    id: "urgency.countdown",
    family: "urgency",
    label: "Countdown timer",
    mechanism: "A visible deadline shortens deliberation and pushes a decision toward now.",
    citation:
      "Mathur, A. et al. (2019). Dark Patterns at Scale: Findings from a Crawl of 11K Shopping Websites. Proc. ACM Human-Computer Interaction, 3(CSCW), Article 81.",
    severityWeight: 0.7,
    tier: 1,
    crossStage: false,
    temporal: false,
  },
  "social_proof.live_activity": {
    id: "social_proof.live_activity",
    family: "social_proof",
    label: "Live activity notice",
    mechanism:
      "Seeing what other people are doing is used as evidence about what is correct to do.",
    citation:
      "Cialdini, R. B. (2007). Influence: The Psychology of Persuasion (rev. ed.). Harper Business. See also Mathur et al. (2019), activity-notification category.",
    severityWeight: 0.7,
    tier: 1,
    crossStage: false,
    temporal: false,
  },
  "defaults.preselected": {
    id: "defaults.preselected",
    family: "defaults",
    label: "Preselected option",
    mechanism:
      "Whatever is already selected is what most people end up with, whatever they would have picked.",
    citation:
      "Johnson, E. J. & Goldstein, D. (2003). Do Defaults Save Lives? Science, 302(5649), 1338–1339.",
    severityWeight: 0.8,
    tier: 1,
    crossStage: false,
    temporal: false,
  },
  "confirmshaming.decline_copy": {
    id: "confirmshaming.decline_copy",
    family: "confirmshaming",
    label: "Loaded decline wording",
    mechanism:
      "The option to say no is written so that choosing it means agreeing with something unflattering about yourself.",
    citation:
      "Gray, C. M., Kou, Y., Battles, B., Hoggatt, J. & Toombs, A. L. (2018). The Dark (Patterns) Side of UX Design. Proc. CHI 2018, Paper 534.",
    severityWeight: 0.6,
    tier: 1,
    crossStage: false,
    temporal: false,
  },
  "goal_gradient.threshold": {
    id: "goal_gradient.threshold",
    family: "goal_gradient",
    label: "Spend threshold",
    mechanism:
      "Effort toward a goal rises as the goal appears closer, so a near-miss threshold pulls spending upward.",
    citation:
      "Kivetz, R., Urminsky, O. & Zheng, Y. (2006). The Goal-Gradient Hypothesis Resurfaces. Journal of Marketing Research, 43(1), 39–58.",
    severityWeight: 0.55,
    tier: 1,
    crossStage: false,
    temporal: false,
  },

  // ------------------------------- Tier 2 -------------------------------
  "pricing.drip": {
    id: "pricing.drip",
    family: "pricing",
    label: "Fees added later",
    mechanism:
      "Required charges shown after the first price make the total harder to compare in advance.",
    citation:
      "Morwitz, V., Greenleaf, E. & Johnson, E. (1998). Divide and Prosper: Consumers' Reactions to Partitioned Prices. Journal of Marketing Research, 35(4), 453–463. See also FTC (2015), Economic Analysis of Drip Pricing.",
    severityWeight: 0.95,
    tier: 2,
    crossStage: true,
    temporal: false,
  },
  "interference.visual_asymmetry": {
    id: "interference.visual_asymmetry",
    family: "interference",
    label: "Unequal button emphasis",
    mechanism:
      "When one choice is far more visually prominent than the other, the quieter option is chosen less often.",
    citation:
      "Luguri, J. & Strahilevitz, L. J. (2021). Shining a Light on Dark Patterns. Journal of Legal Analysis, 13(1), 43–109.",
    severityWeight: 0.75,
    tier: 2,
    crossStage: false,
    temporal: false,
  },
  "decoy.asymmetric_dominance": {
    id: "decoy.asymmetric_dominance",
    family: "decoy",
    label: "Decoy option",
    mechanism:
      "Adding an option that is clearly worse than one other option makes that other option look better.",
    citation:
      "Huber, J., Payne, J. W. & Puto, C. (1982). Adding Asymmetrically Dominated Alternatives: Violations of Regularity and the Similarity Hypothesis. Journal of Consumer Research, 9(1), 90–98.",
    severityWeight: 0.6,
    tier: 2,
    crossStage: false,
    temporal: false,
  },
  "nagging.repeat_interstitial": {
    id: "nagging.repeat_interstitial",
    family: "nagging",
    label: "Repeated interruption",
    mechanism:
      "Repeating a request raises the chance of agreement by making refusal cost more effort each time.",
    citation:
      "Gray, C. M., Kou, Y., Battles, B., Hoggatt, J. & Toombs, A. L. (2018). The Dark (Patterns) Side of UX Design. Proc. CHI 2018, Paper 534.",
    severityWeight: 0.5,
    tier: 2,
    crossStage: false,
    temporal: false,
  },
  "basket.sneak": {
    id: "basket.sneak",
    family: "basket",
    label: "Unrequested cart item",
    mechanism: "An item is in the cart without a matching add action from the shopper.",
    citation:
      'Mathur, A. et al. (2019). Dark Patterns at Scale. Proc. ACM Human-Computer Interaction, 3(CSCW), Article 81, "sneak into basket" category.',
    severityWeight: 0.95,
    tier: 2,
    crossStage: true,
    temporal: false,
  },
  "framing.savings_ratio": {
    id: "framing.savings_ratio",
    family: "framing",
    label: "Savings framing",
    mechanism:
      "The same discount is shown as whichever of percentage or dollar amount looks larger.",
    citation:
      "Tversky, A. & Kahneman, D. (1981). The Framing of Decisions and the Psychology of Choice. Science, 211(4481), 453–458. See also Chen, S.-F. S., Monroe, K. B. & Lou, Y.-C. (1998). The Effects of Framing Price Promotion Messages on Consumers’ Perceptions and Purchase Intentions. Journal of Retailing, 74(3), 353–372.",
    severityWeight: 0.45,
    tier: 2,
    crossStage: false,
    temporal: false,
  },
  "loss_aversion.exit_intent": {
    id: "loss_aversion.exit_intent",
    family: "loss_aversion",
    label: "Exit-intent offer",
    mechanism:
      "An offer shown at the moment of leaving is framed as something about to be lost rather than gained.",
    citation:
      "Kahneman, D. & Tversky, A. (1979). Prospect Theory: An Analysis of Decision under Risk. Econometrica, 47(2), 263–291.",
    severityWeight: 0.5,
    tier: 2,
    crossStage: false,
    temporal: false,
  },

  // ------------- Temporal (§18A): recorded from v1, claims need repeat visits -------------
  "temporal.evergreen_countdown": {
    id: "temporal.evergreen_countdown",
    family: "temporal",
    label: "Timer that resets",
    mechanism: "A deadline that moves forward on each visit is not a fixed point in time.",
    citation:
      "FTC Act §5 deceptive-practices analysis. See also UK Competition and Markets Authority (2022), Online Choice Architecture: How Digital Design Can Harm Competition and Consumers, CMA157.",
    severityWeight: 1.0,
    tier: 2,
    crossStage: false,
    temporal: true,
  },
  "temporal.stock_nonmonotonic": {
    id: "temporal.stock_nonmonotonic",
    family: "temporal",
    label: "Stock count that does not settle",
    mechanism:
      "A remaining-units count that rises and falls, or resets on reload, is not tracking one inventory.",
    citation:
      "Mathur, A. et al. (2019). Dark Patterns at Scale. Proc. ACM Human-Computer Interaction, 3(CSCW), Article 81, low-stock-message category.",
    severityWeight: 0.9,
    tier: 2,
    crossStage: false,
    temporal: true,
  },
  "temporal.reference_price_ungrounded": {
    id: "temporal.reference_price_ungrounded",
    family: "temporal",
    label: "Reference price never observed",
    mechanism:
      'A "was" price that has not been the actual price on any visit gives the comparison no observed basis.',
    citation:
      "FTC Guides Against Deceptive Pricing, 16 C.F.R. Part 233. See also UK CMA guidance on reference pricing under the Consumer Protection from Unfair Trading Regulations.",
    severityWeight: 1.0,
    tier: 2,
    crossStage: false,
    temporal: true,
  },
  "temporal.social_proof_synthetic": {
    id: "temporal.social_proof_synthetic",
    family: "temporal",
    label: "Viewer count distribution",
    mechanism:
      "Counts drawn from a narrow range, or identical after each reload, behave like generated numbers rather than measurements.",
    citation:
      "Mathur, A. et al. (2019). Dark Patterns at Scale. Proc. ACM Human-Computer Interaction, 3(CSCW), Article 81, activity-notification category.",
    severityWeight: 0.85,
    tier: 2,
    crossStage: false,
    temporal: true,
  },

  /**
   * Found in the field during the manual spot-check, on Frontier's fare-upsell modal.
   * Not in the original taxonomy, the plan's list came from the literature, and this is a
   * shape the literature does not name cleanly.
   *
   * The upgrade path is one click. The decline path requires ticking "I understand
   * purchasing options separately may result in a higher overall price" and THEN clicking.
   * So the cheaper choice costs an extra action plus a formal admission of disadvantage.
   *
   * Distinct from confirmshaming (which mocks: "No thanks, I hate saving money") and from
   * the default effect (which is about what is pre-selected). The mechanism here is
   * asymmetric friction plus forced attestation.
   *
   * NOTE FOR WHOEVER BUILDS THIS: the strong signal is STRUCTURAL, not lexical, a gate on
   * the decline control that the accept control does not have. Lead with that. Two of the
   * three misses in the spot-check came from lexicons written against imagined copy.
   *
   * Caveat to preserve in the copy: airlines have genuine regulatory reasons to require
   * acknowledgement that a basic fare excludes bags. This may be compliance rather than
   * persuasion, which is exactly why the prompt asks a question and asserts nothing.
   */
  "obstruction.decline_attestation": {
    id: "obstruction.decline_attestation",
    family: "confirmshaming",
    label: "Extra step to decline",
    mechanism:
      "Choosing the cheaper option takes an extra step, and requires agreeing that it may cost you more.",
    citation:
      "Gray, C. M., Kou, Y., Battles, B., Hoggatt, J. & Toombs, A. L. (2018). The Dark (Patterns) Side of UX Design. Proc. CHI 2018, Paper 534; the obstruction and interface-interference categories. See also FTC Negative Option Rule, 16 C.F.R. Part 425, on asymmetry between opting in and opting out.",
    severityWeight: 0.7,
    tier: 3,
    crossStage: false,
    temporal: false,
  },

  // --------------------- Tier 3: declared, not implemented ---------------------
  "reciprocity.free_gift": {
    id: "reciprocity.free_gift",
    family: "reciprocity",
    label: "Free gift",
    mechanism: "Receiving something first creates a felt obligation to give something back.",
    citation:
      "Regan, D. T. (1971). Effects of a Favor and Liking on Compliance. Journal of Experimental Social Psychology, 7(6), 627–639.",
    severityWeight: 0.4,
    tier: 3,
    crossStage: false,
    temporal: false,
  },
  "authority.trust_badges": {
    id: "authority.trust_badges",
    family: "authority",
    label: "Trust badge",
    mechanism:
      "Symbols of authority increase agreement even when the authority behind them is not checked.",
    citation:
      "Cialdini, R. B. (2007). Influence: The Psychology of Persuasion (rev. ed.). Harper Business.",
    severityWeight: 0.35,
    tier: 3,
    crossStage: false,
    temporal: false,
  },
  "forced_continuity.trial_to_paid": {
    id: "forced_continuity.trial_to_paid",
    family: "forced_continuity",
    label: "Trial converting to paid",
    mechanism:
      "A trial that starts billing on its own relies on the same default effect as a preselected checkbox.",
    citation:
      "Restore Online Shoppers' Confidence Act, 15 U.S.C. §8403. See also FTC Negative Option Rule, 16 C.F.R. Part 425.",
    severityWeight: 0.85,
    tier: 3,
    crossStage: true,
    temporal: false,
  },
  "review_integrity.unverified": {
    id: "review_integrity.unverified",
    family: "review_integrity",
    label: "Review provenance",
    mechanism:
      "Ratings shown without any statement of where they came from cannot be told apart from curated ones.",
    citation:
      "FTC Rule on the Use of Consumer Reviews and Testimonials, 16 C.F.R. Part 465 (2024).",
    severityWeight: 0.55,
    tier: 3,
    crossStage: false,
    temporal: false,
  },
} as const satisfies Record<string, TaxonomyEntry>;

export type PatternId = keyof typeof TAXONOMY;

export const PATTERN_IDS = Object.keys(TAXONOMY) as [PatternId, ...PatternId[]];

/** The five that ship to the surfacing path on Day 1 (plan §3, T13). */
export const V1_SURFACING_PATTERNS = [
  "anchoring.reference_price",
  "pricing.charm",
  "scarcity.stock",
  "urgency.countdown",
  "defaults.preselected",
] as const satisfies readonly PatternId[];

export function entry(id: PatternId): TaxonomyEntry {
  return TAXONOMY[id];
}

export function familyOf(id: PatternId): PatternFamily {
  return TAXONOMY[id].family;
}
