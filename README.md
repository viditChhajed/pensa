# Persuasion Patterns

A Manifest V3 extension that passively notices the persuasion architecture on shopping pages
and, at add-to-cart or checkout, asks a question about what was actually on screen.

**Design principle: observe and question, never accuse.** It reports what a page displayed
("this page showed a countdown timer") and asks a question. It never asserts intent,
deception, or illegality — an ethical constraint first, and a store-review one second.

## Status — pilot, end of Day 3

Working locally, not submitted, not published.

| | |
|---|---|
| Page detectors | 14 (9 Tier 1 + 5 Tier 2) |
| Cross-stage detectors | `pricing.drip`, `basket.sneak` |
| Temporal claims (§18A) | 4, needing repeat visits by construction |
| Unit tests | 180 passing |
| Bundle | 106.9 KB gzipped (budget 120) |
| `host_permissions` | empty, asserted at build and in CI |
| Network requests | zero |

**Tier 1:** `anchoring.reference_price`, `pricing.charm`, `scarcity.stock`,
`urgency.countdown`, `defaults.preselected`, `social_proof.live_activity`,
`confirmshaming.decline_copy`, `goal_gradient.threshold`, `bnpl.installments`

**Tier 2:** `interference.visual_asymmetry` (WCAG contrast, area, weight),
`decoy.asymmetric_dominance`, `nagging.repeat_interstitial`, `framing.savings_ratio`,
`loss_aversion.exit_intent`

**Temporal (§18A):** `temporal.evergreen_countdown`, `temporal.stock_nonmonotonic`,
`temporal.reference_price_ungrounded`, `temporal.social_proof_synthetic`

The temporal engine is the part that is hard to replicate. Every other tool in this space
judges a page in isolation; this one keeps a local per-offer history and derives claims no
single page can support — a countdown whose deadline advances with the clock, a stock count
that rises as well as falls, a reference price never once observed as the actual price. It
needs no server and no consent beyond install, and it gets stronger the longer it is used.
It also, by construction, says nothing on a first visit.

### Known gaps — not claimed as done

- **Precision is unmeasured.** The manual spot-check across real retailers (§10) has not
  run. Thresholds are hand-set guesses, marked `hand_set` in the schema so they cannot be
  mistaken for calibrated values. No precision claim should be made until that happens.
- **Never loaded in a real browser.** All 180 tests are jsdom and unit-level. The permission
  grant flow, runtime script registration, IndexedDB round-trip, and overlay rendering have
  not been exercised in Chrome.
- **No telemetry backend**, by design for now — consent flow and local queue only.
- **§18D–G not built.** The n-gram classifier, empirical interference baselines, structural
  pattern mining and cross-user verification. Interfaces exist so they drop in without a
  rewrite.
- **`offerKey.ts` title-similarity matching is written but unused** — offer identity resolves
  via JSON-LD/SKU/GTIN/URL-hash; the trigram fallback for matching cart lines to PDP products
  is not yet wired.

## Permissions

Four, and no host permissions at install:

| Permission | Why |
|---|---|
| `storage` | Remember your per-site choices and the local event log |
| `scripting` | Register the detector script *after* you grant a site |
| `activeTab` | Read the current tab's URL in the popup, so it can offer that site |
| `declarativeContent` | Light up the toolbar icon on shopping URLs **without reading pages** |

Site access is granted one origin at a time, by you, from the popup. ~150 shopping origins
are listed in `optional_host_permissions`, which is what keeps the install prompt near-empty;
none of them are granted until you ask.

The extension never offers to run on banking, health, government, or webmail origins. That
denylist is checked *before* any commerce score and cannot be overridden by one.

## Architecture

Detectors are **pure functions**: `(ctx: PageContext) => DetectionCandidate[]`. They never
touch the DOM, never mutate state, never call the network. Every DOM read happens in one
batched phase before any detector runs, which makes layout thrashing structurally impossible
rather than merely discouraged, and means the same detector bundle can run in Node against a
serialized DOM.

```
src/
  shared/      schema (Zod), taxonomy, money (bigint minor units), url scoring
  content/     harvest (read phase) -> detectors (pure) -> salience -> ui
  entrypoints/ background (SW), detector (unlisted script), popup, options
rulepacks/     allowlist + denylist, as data
```

`src/shared/taxonomy.ts` is the bridge between the code and the write-up: every pattern
carries its mechanism, its primary citation, and a severity weight.

## Development

```bash
npm install
```

```bash
npm run build
```

Then load `.output/chrome-mv3` as an unpacked extension at `chrome://extensions`.

```bash
npm test
```

```bash
npm run compile
```

## Things worth knowing before changing this

- **`host_permissions` must stay empty.** A content script declared in the manifest
  implicitly grants its match patterns at install, which would produce a 150-site install
  warning. The detector is built as an unlisted script and registered at runtime instead.
  The build throws if this regresses; `tests/unit/manifest.test.ts` also guards it.
- **`chrome.permissions.request()` must not be preceded by `await`.** The user gesture is
  consumed by the first yield to the event loop. The popup resolves the origin on open, so
  the click handler is synchronous.
- **The overlay must never cover a checkout button.** `pointer-events: none` on the host is
  necessary but not sufficient — the card re-enables them. Placement is chosen by rectangle
  intersection against every interactive element in the viewport. See
  `tests/unit/card-position.test.ts`, which encodes a failure found in a real browser.
- **Prices are bigint minor units, never floats.** Reconciliation is
  `total − Σ(items)`; float error there manufactures phantom fees.

## Privacy

Zero network egress. See [PRIVACY.md](PRIVACY.md).
