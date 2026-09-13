# Persuasion Patterns

A Manifest V3 extension that passively notices the persuasion architecture on shopping pages
and, at add-to-cart or checkout, asks a question about what was actually on screen.

**Design principle: observe and question, never accuse.** It reports what a page displayed
("this page showed a countdown timer") and asks a question. It never asserts intent,
deception, or illegality — an ethical constraint first, and a store-review one second.

## Status — feature-complete, not submitted

Working locally, verified in real Chromium, **not submitted**. The remaining blockers are
things I cannot do: a $5 developer account, a reachable privacy-policy URL, and screenshots
taken through a native permission dialog no automation can accept.

| | |
|---|---|
| Patterns shipped | **20** — 14 on-page + 2 cross-stage + 4 derived from visit history |
| Unit tests | 321 |
| Real-browser e2e | 38 passing, 3 skipped (sites unreachable from this network) |
| Bundle | 116 KB gzipped across all bundles; 27 KB is the content script, which is the number that matters on every page load |
| `host_permissions` | empty — the build throws otherwise, asserted on the built manifest |
| Network requests | **zero, asserted** — including with telemetry switched on |
| Card placement | 12/12 samples across 4 live retailers × 3 scroll depths |
| Precision | 0 confirmed false positives in ~44 firings across 6 retailers — see the caveat below |

**On the page (14):** `anchoring.reference_price`, `pricing.charm`, `scarcity.stock`,
`urgency.countdown`, `defaults.preselected`, `social_proof.live_activity`,
`confirmshaming.decline_copy`, `goal_gradient.threshold`, `bnpl.installments`,
`interference.visual_asymmetry`, `decoy.asymmetric_dominance`, `nagging.repeat_interstitial`,
`framing.savings_ratio`, `loss_aversion.exit_intent`

**Across a checkout flow (2):** `pricing.drip`, `basket.sneak` — these live in the service
worker and take a session ledger rather than a page, so they are not in the content-script
registry.

**Across repeat visits (4):** `temporal.evergreen_countdown`, `temporal.stock_nonmonotonic`,
`temporal.reference_price_ungrounded`, `temporal.social_proof_synthetic` — claims about how
something *changed* between visits, so they are derived in the worker from the observation
store and cannot be page detectors. They say nothing on a first visit, by construction.

Tier 2 and the temporal set were originally held for v1.1 (plan §13). That boundary moved
deliberately: both were built and tested alongside Tier 1, and the spot-check made the cost
concrete — flyfrontier's fare grid is a textbook asymmetric-dominance decoy and the extension
produced zero detections on it, because the only detector that could see it was excluded from
the bundle. `tests/unit/scope.test.ts` now asserts the shipped set is *present* in the built
bundles, and that the temporal four are in the worker and never in the page registry.

`src/shared/classifier.ts` is unwired scaffolding with no trained weights. It ships nothing,
and a test asserts its identifiers are absent from the build — a partially-trained classifier
scoring real pages would be worse than no classifier.

### Known gaps — not claimed as done

- **Precision passed its gate on a smaller sample than planned.** Plan §10 asked for 30–40
  pages across ≥6 retailers; what ran was 6 retailers and ~44 firings, with zero confirmed
  false positives ([EVAL.md](EVAL.md)). That satisfies the "~4 false positives" gate, but it
  is a narrow sample and every threshold is still a hand-set guess, marked
  `confidenceBasis: "hand_set"` so it cannot be mistaken for a calibrated value. **No stronger
  precision claim than the one in the table above may be made anywhere.**
- **Recall is unmeasured, and is the weaker side.** The §10 gate was built to catch a detector
  crying wolf. Nothing is crying wolf. What the spot-check actually surfaced was misses, which
  that gate cannot see.
- **The permission gesture is unverified by automation.** `permissions.request()` raises a
  native dialog no automation can accept, so the grant flow is checked by hand
  ([SPOT-CHECK.md](SPOT-CHECK.md)). It has been exercised manually on six sites.
- **On very dense pages the extension reads only part of the DOM.** The harvest phase is
  time-budgeted at 35 ms; newegg has ~3900 qualifying nodes and about 2700 are read. Truncation
  follows document order, so what is dropped is the bottom of a long page. It logs when this
  happens. Nodes that appeared or changed while you were looking are exempt from the budget,
  because those carry the highest-value signals.
- **No telemetry backend**, by design. The consent checkbox and the local record shape exist;
  nothing transmits, and four e2e tests assert that. Wiring a real endpoint is a decision that
  has not been made, and would invalidate the zero-network claim above.

## Permissions

Four, and no host permissions at install:

| Permission | Why |
|---|---|
| `storage` | Remember your per-site choices and the local event log |
| `scripting` | Register the detector script *after* you grant a site |
| `activeTab` | Read the current tab's URL in the popup, so it can offer that site |
| `declarativeContent` | Light up the toolbar icon on shopping URLs **without reading pages** |

Site access is granted one origin at a time, by you, from the popup. `optional_host_permissions`
lists ~150 named shopping origins **and `https://*/*`** — optional, so none of it is granted
at install and the install prompt asks for nothing. The broad pattern is there because a
fixed list of shopping sites is always wrong: the extension is useless on the small
independent store a person actually buys from. It is never *requested* as a pattern; the
popup only ever requests the single registrable domain you are looking at.

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
