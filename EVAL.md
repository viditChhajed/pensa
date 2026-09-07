# EVAL — manual spot-check

**Status: NOT YET RUN. No data below.**

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

| Detector | Firings | Correct | False positives | Precision | Decision |
|---|---|---|---|---|---|
| `anchoring.reference_price` | | | | | |
| `pricing.charm` | | | | | |
| `scarcity.stock` | | | | | |
| `urgency.countdown` | | | | | |
| `defaults.preselected` | | | | | |
| `social_proof.live_activity` | | | | | |
| `confirmshaming.decline_copy` | | | | | |
| `goal_gradient.threshold` | | | | | |
| `bnpl.installments` | | | | | |
| `pricing.drip` | | | | | |
| `basket.sneak` | | | | | |

**Decision** is one of: `ship as-is` · `raise threshold to X` · `default-disabled`.

---

## Observation log

One row per detector firing. `page` is a short label, not a full URL — a URL with a query
string can carry session and account identifiers, and this file is committed.

| # | detector | page | retailer | category | stage | fired? | correct? | false positive? | notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |
| 4 | | | | | | | | | |
| 5 | | | | | | | | | |
| 6 | | | | | | | | | |
| 7 | | | | | | | | | |
| 8 | | | | | | | | | |
| 9 | | | | | | | | | |
| 10 | | | | | | | | | |
| 11 | | | | | | | | | |
| 12 | | | | | | | | | |
| 13 | | | | | | | | | |
| 14 | | | | | | | | | |
| 15 | | | | | | | | | |
| 16 | | | | | | | | | |
| 17 | | | | | | | | | |
| 18 | | | | | | | | | |
| 19 | | | | | | | | | |
| 20 | | | | | | | | | |
| 21 | | | | | | | | | |
| 22 | | | | | | | | | |
| 23 | | | | | | | | | |
| 24 | | | | | | | | | |
| 25 | | | | | | | | | |
| 26 | | | | | | | | | |
| 27 | | | | | | | | | |
| 28 | | | | | | | | | |
| 29 | | | | | | | | | |
| 30 | | | | | | | | | |
| 31 | | | | | | | | | |
| 32 | | | | | | | | | |
| 33 | | | | | | | | | |
| 34 | | | | | | | | | |
| 35 | | | | | | | | | |
| 36 | | | | | | | | | |
| 37 | | | | | | | | | |
| 38 | | | | | | | | | |
| 39 | | | | | | | | | |
| 40 | | | | | | | | | |

### Column meanings

- **fired?** — `Y`/`N`. Did the detector produce a detection at all?
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

Measured on live storefronts, the card is often suppressed because no placement is free of
interactive controls (target, ikea, newegg suppressed; rei placed a full card). Storefronts
are nav-dense and are **not** where the digest fires, so this is a pessimistic sample — cart
and checkout pages are usually sparser. Record the real rate here.

| Retailer | Stage | Card shown? | Mode (card / pill / suppressed) |
|---|---|---|---|
| | | | |
| | | | |
| | | | |

If suppression turns out to be common at cart/checkout, that is a product problem, not a
safety one — the fix is a smaller affordance, not permission to cover a control.
