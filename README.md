# Persuasion Patterns

A Manifest V3 extension that passively notices the persuasion architecture on shopping pages
and, at add-to-cart or checkout, asks a question about what was actually on screen.

**Design principle: observe and question, never accuse.** It reports what a page displayed
("this page showed a countdown timer") and asks a question. It never asserts intent,
deception, or illegality — an ethical constraint first, and a store-review one second.

## Status — pilot, scope-locked for v1 submission

Working locally, verified in real Chromium, **not submitted**.

| | |
|---|---|
| Detectors shipped | **16** — 14 page + 2 cross-stage, plus 4 patterns derived from observation history |
| Built but deferred to v1.1 | 9 — 5 Tier-2 page + 4 §18A temporal |
| Unit tests | 233 |
| Real-browser e2e | 26 (1 skipped: native permission dialog) |
| Bundle | 108 KB gzipped (budget 120) |
| `host_permissions` | empty — build throws otherwise, verified by regression |
| Network requests | **zero, asserted** — including with telemetry enabled |

**Shipped (11):** `anchoring.reference_price`, `pricing.charm`, `scarcity.stock`,
`urgency.countdown`, `defaults.preselected`, `social_proof.live_activity`,
`confirmshaming.decline_copy`, `goal_gradient.threshold`, `bnpl.installments`,
`pricing.drip`, `basket.sneak`

**Deferred to v1.1** (plan §13 scopes both post-submission; they were built early — real
scope drift): the 5 Tier-2 page detectors and the 4 §18A temporal claims. Enforced by
exclusion from the import graph, not a flag — `tests/unit/scope.test.ts` asserts their
implementations are absent from the built bundles. `src/shared/classifier.ts` is unwired
scaffolding with no trained weights and ships nothing.

### Known gaps — not claimed as done

- **Precision is unmeasured.** The 30–40 page spot-check has not run. Every threshold is a
  hand-set guess, marked `hand_set` in the schema. See [EVAL.md](EVAL.md) and
  [SPOT-CHECK.md](SPOT-CHECK.md). **No precision claim may be made until that file has data.**
- **The permission gesture is unverified.** `permissions.request()` raises a native dialog no
  automation can accept. Checklist in [SPOT-CHECK.md](SPOT-CHECK.md).
- **The digest suppresses itself often on dense pages.** Measured on live storefronts: target,
  ikea and newegg had no placement free of interactive controls, so nothing showed; rei fit a
  full card. Correct safety behaviour, but it may mean the core interaction rarely fires.
  Storefronts are a pessimistic sample — the digest triggers at cart/checkout, which are
  sparser — and the spot-check will give the real rate.
- **No icons.** The manifest declares none; Chrome shows a placeholder.
- **No telemetry backend**, by design — consent flow and local queue only.

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
