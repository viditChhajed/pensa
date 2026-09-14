# EVAL — manual spot-check

**Status: two runs complete, 6 retailers. §10 gate passed. Decisions below.**

The header used to say precision was unmeasured while the tables below held two runs of
data — the file contradicted itself, which is the specific failure this document exists to
prevent. What is true now:

**Measured:** zero confirmed false positives in ~44 firings across six retailers (run 1),
and zero across five (run 2). That satisfies the §10 gate.

**Not measured:** recall, and precision at the sample size the plan actually asked for
(30–40 pages). Six retailers is a narrow sample, and every threshold in the shipped build is
still a hand-set guess, marked `confidenceBasis: "hand_set"` in the schema so it cannot be
mistaken for a calibrated value.

**The claim that may be made**, and no stronger one: *zero confirmed false positives in ~44
firings across six retailers.* Anything that implies a measured precision rate, a recall
rate, or performance on sites not in these tables is not supported by this file.

---

## Protocol (plan §10)

1. `npm run build`, then load `.output/chrome-mv3` unpacked at `chrome://extensions`.
2. Visit **30–40 pages** across **≥6 retailers**, spanning **≥6 allowlist categories**.
   Category list and suggested sites: [SPOT-CHECK.md](SPOT-CHECK.md).
3. Reach at least the `pdp` and `cart` stages on each retailer; `checkout` where possible
   without paying. Never place an order.
4. For every detector firing, record one row below.
5. Also record pages where a detector **should** have fired and did not (`fired? = N`,
   `should have? = Y`) — misses matter as much as false alarms.

### How to see what fired

The card only appears at add-to-cart / checkout, and only when it can be placed without
covering a control. Do **not** rely on the card alone — read the full log:

- Extension **Settings → What was noticed today** lists everything detected, including
  suppressed items, with a Noticed / Shown split.
- The service worker console (`chrome://extensions` → **Inspect views: service worker`)
  logs `[patterns] digest` lines.

---

## The gate (plan §10)

> Any detector with **more than ~4 false positives** out of its firings gets its threshold
> raised or gets disabled by default.

Fill in the summary table once the log below is populated. Do not soften a bad number —
disabling a noisy detector is a normal outcome, and shipping one is not.

| Detector | Firings | Correct | False positives | Misses | Decision |
|---|---|---|---|---|---|
| `anchoring.reference_price` | ~23 | ~23 | **0** | 1 (shein PDP struck pair) | **ship as-is** |
| `pricing.charm` | ~12 | unknown | **0 confirmed** | 0 | **ship, fix evidence** |
| `scarcity.stock` | 4 | 4 | **0** | 1 (booking "only 3 left at this price") | **ship as-is** |
| `urgency.countdown` | 0 | — | 0 | 1 (shein "Last 5 hours") | **ship as-is** |
| `defaults.preselected` | 0 | — | 0 | 1 (frontier pre-ticked attestation) | **ship as-is** |
| `social_proof.live_activity` | 0 | — | 0 | 0 observed | **ship as-is** |
| `confirmshaming.decline_copy` | 0 | — | **0** | 0 | **ship as-is** — correctly silent on glossier's plain "No thanks" |
| `goal_gradient.threshold` | 1 | 1 | **0** | 1 (shein "add $2.77 more to cart for") | **ship as-is** |
| `bnpl.installments` | 4 | 4 | **0** | 1 (glossier Afterpay, phrase split by markup) | **ship as-is** |
| `pricing.drip` | 0 | — | 0 | unmeasurable — see below | **ship, blocked on stage classifier** |
| `basket.sneak` | 0 | — | 0 | unmeasurable — needs an account | **ship as-is** |

### Decision: NOTHING is disabled and NO threshold is raised.

The §10 gate is "more than ~4 false positives out of a detector's firings". Across
six sites and roughly 44 firings there are **zero confirmed false positives**. The
one detector I suspected — anchoring, ~14 firings on glossier — was verified
correct against the live DOM.

That is a real result, but it is one-sided. The gate was designed to catch a
detector crying wolf, and nothing is crying wolf. What the data actually shows is
a **recall** problem, which the gate was never built to measure.

**Decision** is one of: `ship as-is` · `raise threshold to X` · `default-disabled`.

**Precision is computed over FIRINGS, not over what was shown.** A detector that fires
correctly 20 times and is placement-suppressed 18 of them has excellent precision and a
display problem. Those are separate defects with separate fixes, and conflating them would
lead me to "fix" a detector that is working.

---

## Observation log

One row per detector firing. `page` is a short label, not a full URL — a URL with a query
string can carry session and account identifiers, and this file is committed.

| # | detector | page | retailer | category | stage | fired? | outcome | correct? | false positive? | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | anchoring.reference_price | search results | booking.com | ota_travel | browse | Y | no-room | **unverified** | ? | Fired x9 every pass. User: more than 9 exist when scrolled, fewer than 9 visible unscrolled — count matches neither. Matched text not captured (logging added after). RE-CHECK. |
| 2 | scarcity.stock | search results | booking.com | ota_travel | browse | **N** | not-fired | — | — | **MISS.** "only 3 left at this price" visibly on page. Lexicon wants "only N left"/"N left in stock"; "at this price" is rate availability, not covered. |
| 3 | bnpl.installments | event/ticket select | ticketmaster | ticketing | pdp | Y | no-room | **Y** | N | Correct x2. PayPal "Pay Now or Pay In 4" + Klarna both visibly present. |
| 4 | pricing.drip | event/ticket select | ticketmaster | ticketing | pdp | N | not-fired | — | — | Not reachable: checkout requires an account. Also page showed "$76.50 (incl. fees)" — fees appear bundled, so there may be no drip here to find. |
| 5 | (stage classifier) | event/ticket select | ticketmaster | ticketing | pdp | — | — | **N** | — | Page has quantity stepper, SUBTOTAL $153.00 and "Reserve Tickets" — functionally a cart, classified pdp. hasOrderSummaryTriple needs subtotal AND total AND tax/shipping; only SUBTOTAL present. |
| 6 | (all) | fare select | flyfrontier | airline | browse | N | not-fired | **Y** | N | Zero detections and correct: no struck prices, no charm fractions ($274/$336/$396/$554), no stock counts, no timer, no preselected boxes on that page. |
| 7 | anchoring.reference_price | fare select | flyfrontier | airline | browse | N | not-fired | — | — | **MISS pattern.** "$274 Discount Den" vs "$277 Standard" is a genuine dual-price anchor with NO strikethrough. Detector requires line-through. Widening is risky — see note below. |
| 8 | pricing.charm | upsell modal | flyfrontier | airline | browse | Y | no-room | **Y** | N | "*Annual membership costs $59.99 per year" — genuinely charm priced, so correct. But low value: it is marketing small print, not the fare. Detector picks largest-rendered price and landed on a footnote. |
| 9 | defaults.preselected | upsell modal | flyfrontier | airline | browse | **N** | not-fired | — | — | **MISS, clearest one so far.** Pre-ticked: "Basic Fare works for me. I understand purchasing options separately may result in a higher overall price." Preselected with direct cost consequence. Lexicon wants warranty/insurance/membership/protection — none present. |
| 10 | (stage classifier) | upsell modal | flyfrontier | airline | browse | — | — | **N** | — | Deep inside a booking flow with an upsell interstitial, classified "browse". Second stage misclassification. |
| 11a | scarcity.stock | cart | shein | fast_fashion | **cart** | Y | no-room | **Y** | N | **CORRECT.** x4: "Almost Sold Out", "Checkout Now (1)Almost sold out!". Genuine scarcity copy, visibly on the page. Four hits are duplicates of the same badge rendered in several places. |
| 11b | bnpl.installments | pdp | shein | fast_fashion | pdp | Y | no-room | **Y** | N | **CORRECT.** x2: "Pay now, or in 4 payments of $3.05" with a Klarna badge. Second confirmed correct site for this detector. |
| 11c | (stage classifier) | cart | shein | fast_fashion | **cart** | — | — | **Y** | — | **First correct stage classification of the run.** us.shein.com/cart hit the path token and the order-summary triple. |
| 11d | pricing.charm | pdp | shein | fast_fashion | pdp | Y | no-room | **N** | **suspect** | Matched "Customers Also Viewed10#KnitEssentials-15%SHEIN PETITE Balle" — concatenated blob text with no visible price. Also "4Local-50%Women's Casual Denim Spliced Jacket". Evidence is meaningless. CAUSE: charm picks the LARGEST-AREA priced node, which on a grid page is a big container whose text is every child run together. It should prefer leaf price nodes. |
| 11e | anchoring.reference_price | pdp | shein | fast_fashion | pdp | **N** | not-fired | — | — | **MISS, and the clearest possible case.** PDP shows "$12.23 $16.19 -24%" with $16.19 struck through — a textbook was/now pair. Needs diagnosis against the live DOM. |
| 11f | goal_gradient.threshold | cart | shein | fast_fashion | cart | **N** | not-fired | — | — | **MISS.** Cart shows "Add $2.77 more to cart for FREE STANDARD SHIPPING on SHEIN products!". Patterns want "add $X more to get/unlock/qualify"; "more to cart for" is not covered. Same lexical brittleness as the other misses. |
| 11g | nagging.repeat_interstitial | home | shein | fast_fashion | browse | — | — | — | — | Two separate interstitials on load ("Welcome To The SHEIN US Site 30% OFF", then "Claim your 1 coupons 70% OFF"). Would have fired if shipped. Deferred to v1.1 — noting that the field data supports it. |
| 12a | goal_gradient.threshold | bag | glossier | dtc | pdp | Y | no-room | **Y** | N | **CORRECT.** "You're $15.50 away from free shipping" — first confirmation for this detector. Note it fired here but MISSED shein's "Add $2.77 more to cart for FREE STANDARD SHIPPING", so the pattern set is partially right. |
| 12b | anchoring.reference_price | pdp + bag | glossier | dtc | pdp | Y | off-screen | **Y** | **N** | **VERIFIED CORRECT.** Live-page probe found real `<s>` elements at y=3963-5932 with parent text "Regular price $26 / $91 / $36 / $127" — genuine was/now pairs in a recommendations carousel, below the fold. Detected and correctly NOT surfaced. The salience gate did its job. |
| 12d | bnpl.installments | pdp | glossier | dtc | pdp | **N** | not-fired | — | — | **MISS.** "or 4 interest-free payments of $8.75 with Afterpay" is plainly on the page and the regex covers "N interest-free payments of". Likely cause: the amount is bold, so the phrase is split across elements and no single node carries the whole match. Same root cause as the charm blob problem — node granularity. |
| 12e | (stage classifier) | bag | glossier | dtc | **pdp** | — | — | **N** | — | Third misclassification. Shopping bag with Subtotal $35.00, Savings -$10.50, Estimated total $24.50 and a Checkout button, called "pdp". URL is /products/body-spritz — a Shopify bag drawer keeps the product URL, so the path token wins. |
| 12f | nagging / confirmshaming | home | glossier | dtc | browse | **N** | not-fired | — | — | "Join the list" modal with a plain "No thanks" decline. confirmshaming CORRECTLY silent — "No thanks" is neutral, exactly the negative case in the unit tests. Good restraint. |
| 13 | **obstruction.decline_attestation** | upsell modal | flyfrontier | airline | browse | **N** | not-fired | — | — | **NEW PATTERN, no detector exists.** Upgrade = 1 click. Decline = tick "I understand purchasing options separately may result in a higher overall price" + click. Asymmetric friction plus forced attestation. Added to taxonomy as Tier 3. |
| 12 | | | | | | | | | | |
| 4 | | | | | | | | | | |
| 5 | | | | | | | | | | |
| 6 | | | | | | | | | | |
| 7 | | | | | | | | | | |
| 8 | | | | | | | | | | |
| 9 | | | | | | | | | | |
| 10 | | | | | | | | | | |
| 11a | scarcity.stock | cart | shein | fast_fashion | **cart** | Y | no-room | **Y** | N | **CORRECT.** x4: "Almost Sold Out", "Checkout Now (1)Almost sold out!". Genuine scarcity copy, visibly on the page. Four hits are duplicates of the same badge rendered in several places. |
| 11b | bnpl.installments | pdp | shein | fast_fashion | pdp | Y | no-room | **Y** | N | **CORRECT.** x2: "Pay now, or in 4 payments of $3.05" with a Klarna badge. Second confirmed correct site for this detector. |
| 11c | (stage classifier) | cart | shein | fast_fashion | **cart** | — | — | **Y** | — | **First correct stage classification of the run.** us.shein.com/cart hit the path token and the order-summary triple. |
| 11d | pricing.charm | pdp | shein | fast_fashion | pdp | Y | no-room | **N** | **suspect** | Matched "Customers Also Viewed10#KnitEssentials-15%SHEIN PETITE Balle" — concatenated blob text with no visible price. Also "4Local-50%Women's Casual Denim Spliced Jacket". Evidence is meaningless. CAUSE: charm picks the LARGEST-AREA priced node, which on a grid page is a big container whose text is every child run together. It should prefer leaf price nodes. |
| 11e | anchoring.reference_price | pdp | shein | fast_fashion | pdp | **N** | not-fired | — | — | **MISS, and the clearest possible case.** PDP shows "$12.23 $16.19 -24%" with $16.19 struck through — a textbook was/now pair. Needs diagnosis against the live DOM. |
| 11f | goal_gradient.threshold | cart | shein | fast_fashion | cart | **N** | not-fired | — | — | **MISS.** Cart shows "Add $2.77 more to cart for FREE STANDARD SHIPPING on SHEIN products!". Patterns want "add $X more to get/unlock/qualify"; "more to cart for" is not covered. Same lexical brittleness as the other misses. |
| 11g | nagging.repeat_interstitial | home | shein | fast_fashion | browse | — | — | — | — | Two separate interstitials on load ("Welcome To The SHEIN US Site 30% OFF", then "Claim your 1 coupons 70% OFF"). Would have fired if shipped. Deferred to v1.1 — noting that the field data supports it. |
| 12a | goal_gradient.threshold | bag | glossier | dtc | pdp | Y | no-room | **Y** | N | **CORRECT.** "You're $15.50 away from free shipping" — first confirmation for this detector. Note it fired here but MISSED shein's "Add $2.77 more to cart for FREE STANDARD SHIPPING", so the pattern set is partially right. |
| 12b | anchoring.reference_price | pdp + bag | glossier | dtc | pdp | Y | off-screen | **Y** | **N** | **VERIFIED CORRECT.** Live-page probe found real `<s>` elements at y=3963-5932 with parent text "Regular price $26 / $91 / $36 / $127" — genuine was/now pairs in a recommendations carousel, below the fold. Detected and correctly NOT surfaced. The salience gate did its job. |
| 12d | bnpl.installments | pdp | glossier | dtc | pdp | **N** | not-fired | — | — | **MISS.** "or 4 interest-free payments of $8.75 with Afterpay" is plainly on the page and the regex covers "N interest-free payments of". Likely cause: the amount is bold, so the phrase is split across elements and no single node carries the whole match. Same root cause as the charm blob problem — node granularity. |
| 12e | (stage classifier) | bag | glossier | dtc | **pdp** | — | — | **N** | — | Third misclassification. Shopping bag with Subtotal $35.00, Savings -$10.50, Estimated total $24.50 and a Checkout button, called "pdp". URL is /products/body-spritz — a Shopify bag drawer keeps the product URL, so the path token wins. |
| 12f | nagging / confirmshaming | home | glossier | dtc | browse | **N** | not-fired | — | — | "Join the list" modal with a plain "No thanks" decline. confirmshaming CORRECTLY silent — "No thanks" is neutral, exactly the negative case in the unit tests. Good restraint. |
| 13 | **obstruction.decline_attestation** | upsell modal | flyfrontier | airline | browse | **N** | not-fired | — | — | **NEW PATTERN, no detector exists.** Upgrade = 1 click. Decline = tick "I understand purchasing options separately may result in a higher overall price" + click. Asymmetric friction plus forced attestation. Added to taxonomy as Tier 3. |
| 12 | | | | | | | | | | |
| 13 | | | | | | | | | | |
| 14 | | | | | | | | | | |
| 15 | | | | | | | | | | |
| 16 | | | | | | | | | | |
| 17 | | | | | | | | | | |
| 18 | | | | | | | | | | |
| 19 | | | | | | | | | | |
| 20 | | | | | | | | | | |
| 21 | | | | | | | | | | |
| 22 | | | | | | | | | | |
| 23 | | | | | | | | | | |
| 24 | | | | | | | | | | |
| 25 | | | | | | | | | | |
| 26 | | | | | | | | | | |
| 27 | | | | | | | | | | |
| 28 | | | | | | | | | | |
| 29 | | | | | | | | | | |
| 30 | | | | | | | | | | |
| 31 | | | | | | | | | | |
| 32 | | | | | | | | | | |
| 33 | | | | | | | | | | |
| 34 | | | | | | | | | | |
| 35 | | | | | | | | | | |
| 36 | | | | | | | | | | |
| 37 | | | | | | | | | | |
| 38 | | | | | | | | | | |
| 39 | | | | | | | | | | |
| 40 | | | | | | | | | | |

### Column meanings

- **fired?** — `Y`/`N`. Did the detector produce a detection at all? Read this from
  **Settings → What was noticed today**, NOT from whether a card appeared.

- **outcome** — *why you did or did not see it.* This is the column that separates a
  threshold problem from a placement problem, and without it a correct detection that had
  nowhere to render is indistinguishable in the log from a detector that simply missed.
  Take the value straight from the Settings table:

  | value | Settings column | means |
  |---|---|---|
  | `shown` | Shown | rendered on screen; you saw it |
  | `no-room` | No room | ranked in, but nothing rendered. Now rare by design: the card is anchored under the toolbar icon and is allowed to overlap page content, so it no longer refuses a page for being crowded. If you see this, say so — it means something else is wrong. |
  | `off-screen` | Off-screen | found, but never on screen long enough to have been seen (<800 ms), so never a candidate |
  | `not-fired` | absent from the table | the detector produced nothing at all |
  | `deduped` | — | a stronger detection in the same pattern family won the slot |

  **Threshold problems look like `not-fired`. Placement problems look like `no-room`.**
  I act on those two completely differently: `not-fired` means loosening a lexicon or
  lowering a threshold; `no-room` means nothing could be rendered, which no threshold change
  would help. Please do not collapse them.

  Since the card moved under the toolbar icon, `no-room` should essentially never occur —
  the earlier 60% suppression rate was the old "cover nothing clickable" rule, which was
  unsatisfiable on real storefronts. A `no-room` row now is itself a bug report.

- **correct?** — `Y`/`N`. Was the artifact genuinely on the page as described?
- **false positive?** — `Y`/`N`. It fired, but the page did not actually display that
  pattern. *A truthful scarcity message is still a scarcity message* — the tool reports what
  was displayed, never whether it was true, so "only 2 left, and that was accurate" is
  **correct**, not a false positive.
- **notes** — anything that would change a threshold. Most useful: what the matched text was.

---

## What the run actually found

Ranked by how much it matters, not by how loud it was.

**1. Every miss is a lexicon written against imagined copy.** Seven misses, seven
phrasings I invented that no real site uses:

> **MEASURED — 2026-09-14.** 2,639 real snippets from 36 shops were labelled and
> compared against the shipped lexicons. The finding is much larger than run 1
> suspected:
>
> | pattern | positives found | phrasings the lexicon MISSES |
> |---|---|---|
> | `goal_gradient.threshold` | 72 | **71** |
> | `urgency.countdown` | 63 | **56** |
> | `social_proof.live_activity` | 42 | 41 — but see the caveat |
> | `scarcity.stock` | 14 | 12 |
> | `bnpl.installments` | 7 | 5 |
>
> Read that as roughly **nine in ten real instances are phrased in a way the
> regexes cannot see**. Not a handful of gaps — the lexicons are catching the
> minority case.
>
> **Caveat on social_proof, stated because the number flatters us otherwise:**
> 41 of its 42 are AliExpress product-title blobs with "N,000+ sold" welded onto
> the end. That is a sold count, so the label is defensible, but the harvested
> text is a title rather than a badge, and a model trained on it would learn
> AliExpress's title formatting. That figure should not be quoted as recall
> evidence.
>
> Concrete misses, all real copy: "Free standard shipping on orders $40+",
> "(Free standard shipping over $40)", thresholds in ¥ and MX$, "Save 10% when
> you buy 3 or more pairs", "Limited time offer, ends 09/17", "Limited time
> only", "Back in stock soon", "While supplies last", "Hurry! Before these items
> sold out!", "starting at $38/mo.", "I don't want my mystery offer".
>
> **FIXED — 2026-09-14, same day.** The lexicons were rewritten against the real
> copy, measured by `npm run eval:detectors` on the same 2,639 snippets:
>
> | pattern | recall before | recall after | precision after |
> |---|---|---|---|
> | `goal_gradient.threshold` | 0.04 | **0.60** | 0.98 |
> | `urgency.countdown` | 0.11 | **0.79** | 0.93 (was 0.58) |
> | `scarcity.stock` | 0.43 | **0.64** | 1.00 |
> | `bnpl.installments` | 0.29 | **1.00** | 1.00 |
> | `social_proof.live_activity` | 0.00 | 0.05 | 1.00 — see caveat |
>
> Precision did not have to be traded for it. The first threshold rewrite DID cost
> it — recall 0.72 at precision 0.49 — and the cause was one optional group:
> `with (?:any|select|your)?` made a bare "with" a threshold, so every boohoo
> product card ("Extra 15% Off, With Code: 15EXTRA") qualified. 40 of 54 false
> positives from a single `?`.
>
> `social_proof` stays at 0.05 and that is the honest number, not a failure to
> try: 40 of its 42 positives are AliExpress product-title blobs with "N,000+
> sold" welded on. The detector declines them correctly. The two real messages in
> the set — "447 people have purchased this in the last 3 hours!" and a bare
> "LIVE • 279" — both now fire.
>
> Quantity thresholds (BOGO, "buy 3 get the 4th free") are deliberately NOT
> matched. The labelling disagreed with itself about them, and a detector should
> not encode a judgement the labels could not reach consensus on.
>
> **The classifier is not the fix available today.** One model qualified
> (`goal_gradient`, held-out P 0.86 / R 0.67 over 18 positives); `urgency` was
> rejected at P 0.55; three had too few positives to train. 200 positives is not
> enough, and the corpus needs cart and checkout pages, which a homepage crawl
> does not reach. The lexicon additions are available immediately and are most of
> the value — see [CORPUS.md](CORPUS.md).
>
> **These labels are not validation.** They were produced by a model, not a
> person. They are legitimate training data — the text is real — but nothing here
> may be quoted as a precision result, and a model agreeing with the judgement
> that trained it proves nothing. "only 3 left AT THIS PRICE",
"add $2.77 more TO CART FOR", "purchasing options separately may result in a
higher overall price". The unit tests all pass because I wrote the fixtures and
the lexicons from the same imagination. This is the strongest possible argument
for §18D — the n-gram classifier exists precisely to catch phrasings nobody
anticipated, and it is currently unwired scaffolding.

**2. Detectors reason at the wrong node granularity.** charm matched
"Customers Also Viewed10#KnitEssentials-15%SHEIN PETITE Balle" — a concatenated
blob — because it selects the largest-area priced node. bnpl missed
"or 4 interest-free payments of $8.75" because a bold amount splits the phrase
across elements so no single node carries the whole match. Over-reaching and
under-reaching, same root cause.

> **FIXED — 2026-09-13, under-reaching half.** Reproduced first, which changed
> the diagnosis: bnpl was not missing outright but scoring **0.70 against a 0.75
> threshold** when the amount sat in a sibling span, and scarcity was worse than
> recorded — "Only 3 left at this price" split across spans produced **no
> detection at all**, against 0.85 flat. Both now read the immediate parent's
> joined text when their own node carries only part of the sentence, one claim
> per parent, never for a parent already matched directly. The evidence quotes
> the sentence rather than the fragment, or the card would say “3”.
> `tests/unit/splitNodes.test.ts`, 10 tests including the negatives that hold the
> line: "2 sizes left" is still refused, and a bare number is not paired with
> words from an unrelated sibling.
>
> **The over-reaching half is fixed too**, earlier and separately. charm now
> requires a price node's text to be short (<60 chars) AND requires that no
> deeper candidate carries the same price, which rejects blobs and tight
> wrappers respectively. Verified against the recorded shein blob: it attributes
> to the `$12.99` span, not to "Customers Also Viewed 10 #KnitEssentials …".

**3. The stage classifier is 1-for-4, and it is the most expensive defect.**
Shopify keeps /products/ on the bag drawer; Ticketmaster keeps /event/ on a page
with a subtotal and a Reserve button. pricing.drip compares snapshots ACROSS
stages, so a flow that never leaves one stage disables the highest-value detector
in the product entirely. Two of the four Tier-1-adjacent detectors are gated
behind this.

**4. Performance is a correctness bug, not just jank.** Every site exceeded the
50ms budget; booking and ticketmaster hit the 15s backoff ceiling, at which point
the extension will miss the funnel transition that drip depends on. §18C
dirty-subtree invalidation is specified and unbuilt.

> **FIXED — 2026-09-13.** Two changes. The backoff was switched from wall-clock
> to CPU time, and no site now approaches the 15s ceiling (worst ~1s). Then §18C
> landed for the expensive half: computed style is memoised across passes and
> dropped only for the subtrees the observer saw change. Boxes are still re-read
> every pass, and always will be — `getBoundingClientRect` is viewport-relative,
> so a cached box is wrong after any scroll and no mutation would invalidate it.
>
> Measured on newegg, the densest page in the set (~3900 qualifying nodes against
> a 35 ms per-pass budget):
>
> | | before | after |
> |---|---|---|
> | nodes ever read | ~2700, the same stop every pass | 3909, reached by pass 3 |
> | passes over budget in 35 s | continuous | none after 7.4 s |
>
> The first version of the invalidation had a bug worth recording: any dirty root
> with more than 2000 descendants triggered a *global* flush, which on a loading
> retail page fires every batch. The measured cache hit rate was exactly zero,
> and nothing said so. It is a work budget now, and both the flush and the
> truncation log themselves.

**5. The user never saw a card.** Six sites, zero digests displayed. Placement
suppression is doing exactly what it should — never covering a control — but a
tool whose core interaction never fires is not yet a product.

## Page coverage

Tick off as you go. The target is breadth across categories, not depth on one retailer.

| Category | Retailers visited | Pages |
|---|---|---|
| marketplace | | |
| ota_travel | | |
| airline | | |
| ticketing | | |
| fast_fashion | | |
| subscription_box | | |
| dtc | | |
| food_delivery | | |
| big_box | | |
| electronics | | |

---

## Separate observation: digest suppression rate

Fill this in as you go — it is the input to whether the card needs to shrink.

### Baseline measured before the spot-check

21 samples — 6 reachable sites x 3 scroll depths — running the production placement logic.

| | raw | excluding bad samples |
|---|---|---|
| full card | 52% | **33%** |
| pill | 5% | **7%** |
| suppressed | 43% | **60%** |

**Use the right-hand column.** uniqlo and wayfair reported *zero* interactive controls across
all three scroll depths, which is a blocked or JS-gated render rather than a genuinely empty
page. Those 6 samples inflate the card rate and are excluded.

Scroll depth dominates: target went SUPPRESSED at 0% and 35% scroll, then fitted a full
4-item card at 70%. Header and nav clusters are what fill the corners.

Caveats: these are storefront and category pages, **not** cart or checkout, which is where
the digest actually fires and which are usually sparser. And this measures PLACEMENT only —
no detectors ran, so it says nothing about firing rates.

Record the real rate here as you go.

| Retailer | Stage | Card shown? | Mode (card / pill / suppressed) |
|---|---|---|---|
| booking.com | browse | no | suppressed (dense nav) |
| ticketmaster | pdp | no | suppressed |
| flyfrontier | browse | no | suppressed |

Three of three suppressed. No card was ever seen by the tester across four sites.

### After tiering controls by purchase intent

The conclusion recorded above — "the fix is a smaller affordance, not permission to cover a
control" — was **wrong**, and the error was in the category rather than the size. The rule
was "cover nothing clickable", which on a real storefront is unsatisfiable: header, footer
and nav fill every corner with links. But a footer link reading "Careers" is not something a
shopper needs mid-purchase; the Place Order button is.

Controls are now tiered. Critical (never covered): form fields, submits, the focused
element, and any control whose name is on the purchase path. Ordinary: everything else,
which the card prefers to avoid and is allowed to overlap.

Re-measured live, 4 reachable retailers x 3 scroll depths, running the **shipped** chooser
(the e2e now imports it rather than re-implementing it) and hit-testing the rendered card in
the browser at each sample:

| Retailer | @0% | @35% | @70% |
|---|---|---|---|
| target | card (1 ordinary) | card (0) | card (2) |
| ikea | card (3) | card (1) | card (0) |
| newegg | card (1) | card (1) | card (2) |
| rei | card (0) | card (0) | card (0) |

**12/12 samples place a full card. Zero suppressed. Worst ordinary coverage: 3 links.
Purchase-path controls covered: 0, verified by `elementFromPoint` on every visible control
at every sample.** Before: 0/4.

Scroll depth no longer flips the outcome, which was the specific risk in the baseline above
(target went suppressed -> full card between 0% and 70%). It now places at every depth on
every site, so the earlier figure was measuring the rule, not the pages.

Still to confirm by hand: a card rendering at **cart or checkout** on a real site. Everything
above is storefront and category pages, because a checkout page needs a populated cart and
usually an account.

## Spot-check run 2 — 2026-09-10, build 12:18

Five of six sites, full journeys (product -> cart -> checkout), stopping at the first
authenticated or payment step. Recorded from the console, which now prints the matched
lexemes alongside the sample.

| # | detector | page | retailer | stage | fired? | outcome | correct? | FP? | notes |
|---|---|---|---|---|---|---|---|---|---|
| 20 | anchoring.reference_price | hotel select | booking | cart | Y | not-shown | **Y** | N | x8-9, "$100"/"$120"/"$90". Real struck rates. |
| 21 | — | your details | booking | **browse** | — | — | — | — | **BUG.** Checkout page classified `browse`, so no trigger and no card. Fixed: checkout detection required shipping-address autocomplete; a hotel booking has none. |
| 22 | scarcity.stock | suite listing | ticketmaster | browse | Y | not-shown | **unverified** | ? | "Enjoy the US Open in a spacious, private luxury suite locate". Base copy scores 0 in isolation, so the match is in the truncated remainder. RE-CHECK with lexeme logging. |
| 23 | — | ticket select | ticketmaster | **cart** | — | — | **Y** | — | Correctly `cart` (was `pdp` before the classifier rewrite). Journey ended at the sign-in wall. |
| 24 | — | fare select / bundle | flyfrontier | checkout | **N** | not-fired | — | — | **MISS.** Zero detections on a page of pure persuasion. The decline is a CHECKBOX: "I understand purchasing options separately may result in a higher overall price." Blocked three ways at once — see the follow-ups below. |
| 25 | goal_gradient.threshold | cart | shein | cart | Y | not-shown | **Y** | N | "Add $2.45 more to cart for FREE STANDARD SHIPPING [add,more]". **Previously a recorded miss; the fix is confirmed in the field.** |
| 26 | scarcity.stock | cart | shein | cart | Y | not-shown | **Y** | N | x9 "Almost Sold Out". Correct, but nine duplicates of the same badge. |
| 27 | bnpl.installments | pdp/cart | shein | cart | Y | **off-screen** | **Y** | N | "Pay now, or in 4 payments of $3.13". score=0.70 (below the 0.75 threshold) AND dwell=0ms. Two independent reasons it can never surface. |
| 28 | anchoring.reference_price | bag | glossier | cart | Y | not-shown | **Y** | N | "$84 [regular price]". |
| 29 | defaults.preselected | checkout | glossier | checkout | Y | **shown** | **Y** | N | Pre-ticked "Email me with news and offers". score=0.75, dwell=957ms, card rendered. |

**Zero confirmed false positives across five sites.**

Glossier is the first complete correct funnel traversal in the project: pdp -> cart ->
checkout, all three right, ending in a rendered card.

### pricing.drip still has not fired — and on this evidence that is correct

Glossier was a full product -> cart -> checkout journey on one origin in one session, which
is exactly what drip needs. It stayed quiet. The checkout showed Subtotal $56.00, Shipping
"Enter shipping address", Total $56.00 — **no fee was ever added, so there was nothing to
drip.** A finding would have been wrong.

But the log could not distinguish "the site did not drip" from "the snapshots were empty",
which are very different problems. Each stage transition now prints its captured snapshot —
price, subtotal, total, shipping, and every fee — so the next run can tell them apart
without guessing. Test the claim on a site that actually drips: ticketmaster fees, or an
airline seat/bag flow.

### Open calibration questions for this run

- **bnpl.installments at 0.70** against a 0.75 threshold: correct on two sites, can never
  surface. Same shape as the scarcity question below.
- **scarcity.stock at 0.60 / 0.40** against 0.75: correct on two sites, can only surface
  alongside a progress bar.
- **Duplicate firings**: nine identical "Almost Sold Out" badges produce nine candidates.
  The digest dedupes by family so only one would ever show, but the event log counts nine,
  which will distort any prevalence measure built on it.

## Follow-ups resolved from the spot-check findings

Three items from the table above, fixed and pinned as tests. One of them was recorded here
with the wrong cause, which is noted rather than quietly corrected.

**`pricing.charm` matched a container, not a price (row 11d).** It ranked priced nodes by
rendered area, which on a grid page selects the largest BOX — a container whose text is every
child run together. The logged evidence, "Customers Also Viewed 10 #KnitEssentials -15% SHEIN
PETITE Balle", contains no price at all: the charm price sat further along in text the log
truncated. It now requires the price to BE the node's content (text under 60 chars) and
rejects any node with a descendant carrying the same price. Both guards are needed — the
length test alone still admits a tight wrapper.

**`goal_gradient.threshold` missed Shein's cart threshold (row 11f).** Confirmed. Shein
phrases the threshold as a destination — "Add $2.77 more to cart for FREE STANDARD SHIPPING"
— where the patterns wanted a purpose ("to get/unlock/qualify"). Added. "more" is
load-bearing in the new pattern: without it, it would match the plain "Add to cart" on every
product page on the web. Tested against that.

**`scarcity.stock` on booking.com (row 2) — the recorded cause was wrong.** This was logged
as "lexicon wants 'only N left'; 'at this price' is rate availability, not covered". Measured:
"Only 3 left at this price" *does* match, and scores 0.60. The real gap is that Booking's copy
puts a noun in the middle — "Only 3 **rooms** left at this price" — which scored zero. Fixed
by allowing an enumerated set of inventory nouns (rooms, tickets, seats, units...). NOT `\w+`,
which would have swallowed "only 3 sizes left" — the catalogue-vs-urgency false positive the
plan warns causes uninstalls. Variant exclusions verified still holding.

### Open calibration question, for the next spot-check to decide

Numeric scarcity scores **0.60** (numericStock 0.5 + shortText 0.1) and qualitative scarcity
scores **0.40**, both against a **0.75** surfaceThreshold. So `scarcity.stock` can only ever
surface when a progress bar is present alongside the copy — otherwise it logs and stays
silent. Every confirmed-correct scarcity firing in the table above is in that position.

This is left as found. Reweighting a detector upward so it crosses the surfacing line is a
calibration decision of the same kind as raising a threshold to silence a noisy one, and it
belongs to the spot-check with real firings in front of it, not to a code change made on
its own.

## Performance, observed during the spot-check

| Site | Worst pass | Sustained | Backoff reached |
|---|---|---|---|
| etsy | 104ms | — | 1s |
| booking.com | 1598ms | 60-200ms | 15s (ceiling) |
| ticketmaster | 1689ms | 50-970ms | 15s (ceiling) |
| flyfrontier | 949ms | 64-192ms | 9.5s |

Every site exceeded the 50ms budget, three of four hit or neared the 15s backoff
ceiling. At a 15s gap the extension will miss funnel transitions entirely, which
turns a performance problem into a correctness one.

### Diagnosed: the budget was measuring the wrong thing

This was recorded as the §18C dirty-subtree case — i.e. that harvesting is too expensive.
Measuring per phase showed otherwise. Detectors drain across idle windows, and the pass
measured WALL-CLOCK, which on a busy page is dominated by waiting for the browser to hand
out an idle window (up to 250ms per slice). On target.com: 1255ms wall for 344ms of work.
That wall-clock figure was then divided by the 10% duty cycle to size the backoff — so the
extension penalised itself for yielding politely, and the harder it tried not to block the
page, the blinder it became.

With the duty cycle computed from CPU actually consumed, detector cost turns out to be
1-4ms, not hundreds. The real cost was `readDocumentMeta`, whose two structural scans called
joinedText (and querySelectorAll) per element over the whole document — both O(subtree) per
element, so quadratic. One bottom-up text pass makes it linear.

| Site | CPU before | CPU after | meta | harvest | detectors | Backoff |
|---|---|---|---|---|---|---|
| target | — | under budget | — | — | — | 300ms (floor) |
| ikea | 128ms | under budget | — | — | — | 300ms (floor) |
| newegg | 119ms | **92ms** | 50 | 41 | 0 | ~0.9s |
| rei | 75ms | **75ms** | 29 | 44 | 2 | ~0.75s |

**No site reaches the 15s ceiling any more; the worst case is under a second.** Two of five
now stay inside the 50ms budget entirely. newegg and rei both cap out at MAX_CANDIDATES
(1200), so what remains is the harvest cap, which is the genuine §18C case — but it is now a
~90ms problem, not a 1.8s one, and no longer a correctness risk.
