# Persuasion Patterns

A Manifest V3 extension that passively notices the persuasion architecture on shopping pages
and, at add-to-cart or checkout, asks a question about what was actually on screen.

**Design principle: observe and question, never accuse.** It reports what a page displayed
("this page showed a countdown timer") and asks a question. It never asserts intent,
deception, or illegality — an ethical constraint first, and a store-review one second.

## Status — end of Day 1 (pilot)

Working locally, not submitted, not published. Five detectors, hand-set thresholds, no
telemetry, no persistence beyond the session.

| | |
|---|---|
| Detectors shipping | 5 of 9 Tier 1 |
| Unit tests | 46 passing |
| Bundle | 111.6 KB gzipped (budget 120 KB) |
| `host_permissions` | empty, asserted at build and in CI |
| Network requests | zero |

Detectors live: `anchoring.reference_price`, `pricing.charm`, `scarcity.stock`,
`urgency.countdown`, `defaults.preselected`.

**Not yet done, and not claimed:** the manual spot-check across real retailers. Precision is
currently unmeasured — the thresholds are hand-set guesses, marked `hand_set` in the schema
so nothing here can be mistaken for a calibrated number. Until that spot-check happens, no
precision claim should be made about this extension.

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
