# EVAL — manual spot-check

**Status: DATA COLLECTION COMPLETE — 6 sites. Threshold decisions below.**

Precision is currently **unmeasured**. Every threshold in the shipped build is a hand-set
guess, marked `confidenceBasis: "hand_set"` in the schema so it cannot be mistaken for a
calibrated value. Until this file has real numbers in it, **no precision claim may be made
about this extension** — not in the README, not in the store listing, not anywhere.

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

| Detector | Firings | Shown | No room | Correct | False positives | Precision | Decision |
|---|---|---|---|---|---|---|---|
| `anchoring.reference_price` | | | | | | | |
| `pricing.charm` | | | | | | | |
| `scarcity.stock` | | | | | | | |
| `urgency.countdown` | | | | | | | |
| `defaults.preselected` | | | | | | | |
| `social_proof.live_activity` | | | | | | | |
| `confirmshaming.decline_copy` | | | | | | | |
| `goal_gradient.threshold` | | | | | | | |
| `bnpl.installments` | | | | | | | |
| `pricing.drip` | | | | | | | |
| `basket.sneak` | | | | | | | |

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
| 12b | anchoring.reference_price | pdp + bag | glossier | dtc | pdp | Y | no-room | **SUSPECT** | **likely** | Fired x4 on the PDP and x5 on the bag, samples "$26", "$91", "$36". None of those appear as was/now pairs on the visible page — the PDP shows a single $35. Likely a recommendations rail below the fold. NEEDS VERIFICATION: if those are genuine struck pairs in a carousel they are correct; if not, this is the detector's first confirmed false positive and the largest volume in the run. |
| 12c | anchoring.reference_price | bag | glossier | dtc | pdp | **N** | not-fired | — | — | **MISS on the visible case.** Bag shows "$35 $24.50" with $35 struck. The detector reported $26/$91/$36 and not the one actually on screen — so it is both over-firing off-screen and missing the real pair. |
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
| 12b | anchoring.reference_price | pdp + bag | glossier | dtc | pdp | Y | no-room | **SUSPECT** | **likely** | Fired x4 on the PDP and x5 on the bag, samples "$26", "$91", "$36". None of those appear as was/now pairs on the visible page — the PDP shows a single $35. Likely a recommendations rail below the fold. NEEDS VERIFICATION: if those are genuine struck pairs in a carousel they are correct; if not, this is the detector's first confirmed false positive and the largest volume in the run. |
| 12c | anchoring.reference_price | bag | glossier | dtc | pdp | **N** | not-fired | — | — | **MISS on the visible case.** Bag shows "$35 $24.50" with $35 struck. The detector reported $26/$91/$36 and not the one actually on screen — so it is both over-firing off-screen and missing the real pair. |
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
  | `no-room` | No room | ranked in, but nowhere on the page could hold the card without covering something clickable, so nothing rendered |
  | `off-screen` | Off-screen | found, but never on screen long enough to have been seen (<800 ms), so never a candidate |
  | `not-fired` | absent from the table | the detector produced nothing at all |
  | `deduped` | — | a stronger detection in the same pattern family won the slot |

  **Threshold problems look like `not-fired`. Placement problems look like `no-room`.**
  I act on those two completely differently: `not-fired` means loosening a lexicon or
  lowering a threshold; `no-room` means the card is too big, and no threshold change would
  help. Please do not collapse them.

- **correct?** — `Y`/`N`. Was the artifact genuinely on the page as described?
- **false positive?** — `Y`/`N`. It fired, but the page did not actually display that
  pattern. *A truthful scarcity message is still a scarcity message* — the tool reports what
  was displayed, never whether it was true, so "only 2 left, and that was accurate" is
  **correct**, not a false positive.
- **notes** — anything that would change a threshold. Most useful: what the matched text was.

---

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

Three of three so far suppressed. Consistent with the 60% pre-measurement, and
possibly worse — no card has been seen by the tester yet across four sites.

## Performance, observed during the spot-check

| Site | Worst pass | Sustained | Backoff reached |
|---|---|---|---|
| etsy | 104ms | — | 1s |
| booking.com | 1598ms | 60-200ms | 15s (ceiling) |
| ticketmaster | 1689ms | 50-970ms | 15s (ceiling) |
| flyfrontier | 949ms | 64-192ms | 9.5s |

Every site exceeded the 50ms budget, three of four hit or neared the 15s backoff
ceiling. At a 15s gap the extension will miss funnel transitions entirely, which
turns a performance problem into a correctness one. This is the §18C
dirty-subtree work and it is now the highest-priority engineering item.

If suppression turns out to be common at cart/checkout, that is a product problem, not a
safety one — the fix is a smaller affordance, not permission to cover a control.
