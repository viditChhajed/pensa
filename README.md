# Vero

A Manifest V3 extension that passively notices the persuasion architecture on shopping pages
and, at add-to-cart or checkout, asks a question about what was actually on screen.

**Design principle: observe and question, never accuse.** It reports what a page displayed
("this page showed a countdown timer") and asks a question. It never asserts intent,
deception, or illegality — an ethical constraint first, and a store-review one second.

## Status — feature-complete, not submitted

Working locally, verified in real Chromium, **not submitted**. The remaining blockers are
things I cannot do: a $5 developer account, and screenshots taken through a native permission
dialog no automation can accept. (The privacy-policy URL is live — see
[STORE-LISTING.md](STORE-LISTING.md).)

| | |
|---|---|
| Patterns shipped | **20** — 14 on-page + 2 cross-stage + 4 derived from visit history |
| Unit tests | 478 |
| Real-browser e2e | 43 passing, 3 skipped (sites unreachable from this network) |
| Bundle | 119 KB gzipped across all bundles; 28 KB is the content script, which is the number that matters on every page load |
| `host_permissions` | empty — the build throws otherwise, asserted on the built manifest |
| Network requests | **zero with telemetry off** (the shipped default), asserted; with it on, the only reachable address is the declared endpoint, also asserted |
| Card placement | 12/12 samples across 4 live retailers × 3 scroll depths |
| Detector recall | measured against 29,742 label rows over 4,957 distinct snippets from 44 shops — `npm run eval:detectors`. The corpus itself is **not distributed** (it is real retailer page text); see [CORPUS.md](CORPUS.md) to rebuild it, and `tests/eval/baseline.json` for the committed numbers |
| Manual precision | 0 confirmed false positives in ~44 firings across 6 retailers — see the caveat below |

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

### Measured on real copy

`npm run eval:detectors` runs the shipped detectors over 4,957 labelled snippets collected
from 44 shops and reports precision and recall per pattern. Before that instrument existed,
every number this project had came from fixtures written against lexicons written from the
same imagination — they agreed with each other and with nothing else.

| pattern | recall | precision | |
|---|---|---|---|
| `bnpl.installments` | 1.00 | 1.00 | |
| `goal_gradient.threshold` | 0.72 | 0.98 | |
| `urgency.countdown` | 0.71 | 0.92 | |
| `social_proof.live_activity` | 0.58 | 1.00 | |
| `scarcity.stock` | 0.54 | 1.00 | |
| `confirmshaming.decline_copy` | — | — | not measurable by this harness; see below |

Against the first measurement, before any of this was rewritten:

| pattern | was | now |
|---|---|---|
| `goal_gradient.threshold` | 0.04 | **0.72** |
| `urgency.countdown` | 0.11 | **0.71** |
| `social_proof.live_activity` | 0.00 | **0.58** |
| `bnpl.installments` | 0.29 | **1.00** |
| `scarcity.stock` | 0.43 | **0.54** |

Precision was not traded for it — it sits between 0.92 and 1.00, and every one of those
rewrites was driven by real copy the corpus produced rather than by phrasings anyone imagined.

Those are at the LOG threshold — what gets counted. The surface threshold, which is what
interrupts anyone, is far stricter and its precision is 1.00 across the board.

Read them as **agreement, not correctness**: the labels were produced by a model, not a
person, so a detector agreeing with them is not the same as being right. They support "this
change made it worse", which is the property worth having while lexicons are rewritten —
`tests/eval/baseline.json` is a ratchet and a regression past 0.02 fails.

**`confirmshaming` cannot be measured here, and that is the harness, not the detector.**
Every snippet is rendered as a plain `<div>`, and confirmshaming requires its node to be a
decline CONTROL — it correctly declines to fire on a div. Checked separately: all three of
the corpus's instances ("I Will Pay Full Price!", "I don't want my mystery offer", "NO
THANKS, I'LL RISK IT") score 1.00 wrapped in a `<button>`. Reporting it as 0.00 would send
the next reader to fix something that already works.

The structural detectors — `anchoring`, `charm`, `defaults`, `interference`, `decoy` — are
NOT covered by this either, and that is now measured rather than assumed. The labelling flagged
**163** snippets as reference-price anchoring, which is more evidence than any of the six
text patterns had. **Zero** of them carry a strikethrough in the corpus.

They are not mislabelled. The harvested node is the container — "EGOWide Leg Low Rise
Trousers£21.60£27.00-20%" — and the `<s>` sits on a child the corpus flattens away, so the
style recorded is the wrapper's. Measuring these needs the subtree, not the text, which is a
different collection format and a different privacy question: storing DOM structure from real
pages is a bigger commitment than storing scrubbed sentences.

Worth doing, not done, and the 163 labels are already sitting in `corpus/auto/` for whoever
does it.

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
- **A dense page is read over several passes, not one.** The harvest phase is time-budgeted
  at 35 ms per pass, and newegg's ~3900 qualifying nodes do not fit. Computed style is
  memoised across passes and dropped only for subtrees the MutationObserver saw change (plan
  §18C), so each pass spends its budget on what the last one skipped: measured on newegg,
  coverage goes 1696 → 3456 → full, and after about 7 seconds no pass exceeds the budget at
  all. Within a single pass truncation still follows document order, and nodes that appeared
  or changed while you were looking are exempt from the budget because they carry the
  highest-value signals. Bounding boxes are re-read every pass and deliberately never cached
  — they are viewport-relative, so a scroll would make a cached one wrong with no mutation to
  notice.
- **Telemetry is built end to end but not deployed.** `server/handler.ts` is a host-agnostic
  `(Request) => Response` with 11 tests asserting it disbelieves its client — it re-checks
  every limit the extension already applies, because a public URL has to hold against a
  modified extension or a curl command. It reads no header but `content-type`, and a test
  enforces that: an IP plus an hour bucket plus a site category re-identifies a person.
  `server/cloudflare/` has the Worker, the D1 schema and [DEPLOY.md](server/DEPLOY.md) —
  about 20 minutes. The step that matters most is not in this repo: Cloudflare logs the
  client IP by default and that has to be turned off before deploying.
- **The client holds everything locally.** The queue, the consent gate, the
  k-anonymity floor (k=20) and the six-hourly sender are built and tested;
  `TELEMETRY_ENDPOINT` in `src/shared/constants.ts` is empty, so `flush()` holds everything
  locally and sends nothing. Deploying a server is the remaining step, and it is a decision
  with consequences beyond the code: the Chrome listing's data disclosure changes, and the
  "makes no network requests" line in the store copy becomes conditional. Both are already
  written for either case.
- **Plan §14.4's post-first-digest consent screen is deliberately not built.** §14.4 asks for
  a one-screen telemetry ask after the first digest. Interrupting someone to request consent
  to send data to a server that does not exist is a worse thing to do than not asking — in a
  product whose central argument is about unnecessary interruption. The consent lives in
  Settings, unticked, next to a line saying no server is connected. If an endpoint is ever
  added, the §14.4 screen is the right way to ask for it and should be built then.

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
