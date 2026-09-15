/**
 * bnpl.installments
 *
 * Splitting a price into small future payments reduces how much the cost is felt now. The
 * artifacts are reliable: provider SDK iframes, provider brand names, and a very consistent
 * copy shape ("4 interest-free payments of $24.99").
 *
 * This one has unusually high precision available because the provider names are proper
 * nouns that do not otherwise appear on a product page.
 */

import { parsePrices } from "@/shared/money";
import type { DetectionCandidate } from "@/shared/schema";
import type { Detector, PageContext } from "../types";
import { candidate, matchLexemes, visibleCandidates } from "./util";

const PROVIDERS = [
  "klarna",
  "affirm",
  "afterpay",
  "sezzle",
  "zip",
  "quadpay",
  "clearpay",
  "splitit",
  "paypal pay in 4",
  "shop pay installments",
] as const;

const PROVIDER_HOSTS =
  /(?:klarna|affirm|afterpay|sezzle|quadpay|clearpay|splitit|zip)\.(?:com|co|io|net)/i;

const INSTALLMENT_PATTERNS: readonly RegExp[] = [
  /\b(\d)\s*(?:interest[- ]free\s+)?(?:payments?|installments?|instalments?)\s+of\b/,
  /\bpay in (\d)\b/,
  /**
   * "Buy now, pay later" — the category's own name, and it scored ZERO.
   *
   * Every pattern here required a digit: a count of payments, an amount, or a monthly
   * figure. The plainest possible statement of the technique has none of those, which is the
   * shape of blind spot a lexicon written from examples reliably produces.
   */
  /\bbuy now,?\s*pay later\b/,
  /\bpay (?:over time|later)\b/,
  /** "Pay in full or in installments" — the choice framed, with no count and no amount. */
  // `instal?ments` matches "instalments" but NOT "installments" — the l is doubled, not
  // optional. My own typo, and it silently made the rule unreachable on the US spelling.
  /\bin instal{1,2}ments\b/,
  /\bor\s+\d\s*x\s*[$£€]/,
  /\bas low as\s*[$£€]?\s*[\d.,]+\s*\/\s*(?:mo|month)\b/,
  /\bfrom\s*[$£€]\s*[\d.,]+\s*\/\s*(?:mo|month)\b/,
  /\bsplit (?:it )?into \d+ payments\b/,
  /**
   * "Get the Apple Watch Series 11 starting at $38/mo." — Target's framing, and five of the
   * seven instalment messages in the labelled corpus. No provider name, no "interest-free",
   * no "4 payments of": just a monthly figure standing in for the price.
   */
  /\bstarting at\s*[$£€]\s*[\d.,]+\s*\/\s*mo\b/,
  /\b(?:from|only)\s*[$£€]\s*[\d.,]+\s*(?:a|per|\/)\s*(?:mo|month)\b/,
  /\b\d+ (?:bi-?weekly|fortnightly|monthly) payments\b/,
];

const LEXEMES = [
  "interest-free",
  "interest free",
  "payments of",
  "installments",
  "instalments",
  "pay in 4",
  "as low as",
  "per month",
  "/mo",
] as const;

/**
 * Recalibrated with scarcity, and for the same reason: correct on every firing, never able
 * to surface. Shein's "Pay now, or in 4 payments of $3.13" scored 0.70 against a 0.75
 * threshold on two separate visits.
 *
 * installmentCopy carries the weight because it is the actual claim. A named provider
 * (Klarna, Afterpay, Affirm) is corroboration, and an amount makes it concrete, but
 * "4 payments of $3.13" is already unambiguous on its own.
 */
const WEIGHTS: Record<string, number> = {
  installmentCopy: 0.7,
  providerNamed: 0.25,
  providerFrame: 0.25,
  hasAmount: 0.15,
};

export const bnplDetector: Detector = {
  id: "bnpl.installments@1",
  patternId: "bnpl.installments",
  stages: ["pdp", "cart", "checkout", "payment"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];
    const seen = new Set<string>();

    for (const n of visibleCandidates(ctx)) {
      const t = n.normalizedText;
      if (t.length === 0 || t.length > 220) continue;
      if (seen.has(n.selectorPath)) continue;

      const copy = INSTALLMENT_PATTERNS.some((re) => re.test(t)) ? 1 : 0;
      const named = PROVIDERS.some((p) => t.includes(p)) ? 1 : 0;
      // An SDK iframe or logo pointing at a provider host.
      const src = `${n.attrs.src ?? ""} ${n.attrs.href ?? ""} ${n.attrs.alt ?? ""}`;
      const frame = PROVIDER_HOSTS.test(src) ? 1 : 0;

      // A provider name alone is not enough — "Zip" is also a postcode field label.
      if (copy === 0 && frame === 0) continue;

      seen.add(n.selectorPath);

      /**
       * The amount is allowed to live in a sibling element.
       *
       * Recorded field miss: Shein renders "or 4 interest-free payments of" and "$8.75" as
       * two spans, so the node carrying the claim carries no price and scored 0.70 against a
       * 0.75 threshold — correct on every signal it could see, and never surfaced, twice.
       *
       * Scoped deliberately: `containerText` is the IMMEDIATE parent only, and it is
       * consulted only once the installment copy has already matched on this node. A price
       * sharing a parent with "4 payments of" is that payment; this is not a licence to go
       * hunting up the tree, which is how a detector starts pairing a phrase with the whole
       * page.
       */
      const prices =
        parsePrices(n.text).length > 0 ? parsePrices(n.text) : parsePrices(n.containerText);

      out.push(
        candidate(
          bnplDetector.id,
          "bnpl.installments",
          n,
          {
            installmentCopy: copy,
            providerNamed: named,
            providerFrame: frame,
            hasAmount: prices.length > 0 ? 1 : 0,
          },
          WEIGHTS,
          matchLexemes(n, LEXEMES),
        ),
      );
    }

    return out;
  },
};
