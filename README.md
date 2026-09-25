# Pensa

A Manifest V3 extension that passively notices the persuasion architecture on shopping pages
and, at add-to-cart or checkout, asks a question about what was actually on screen.

**Design principle: observe and question, never accuse.** It reports what a page displayed
("this page showed a countdown timer") and asks a question. It never asserts intent,
deception, or illegality, an ethical constraint first, and a store-review one second.

## Status: reviewed and listed as 1.0.0, with 1.1.0 built and awaiting upload

1.0.0 passed Chrome Web Store review and is listed. It went out under the name **Vero**, which
several other extensions already used, so 1.1.0 renames everything to **Pensa**. Nobody had
installed 1.0.0 at the time of the rename, which is why identifiers that would normally have to
be preserved (the IndexedDB name, the storage keys, the D1 database) were renamed too.

**1.1.0 is built and tested but not uploaded.** It carries the rename, the install-time sharing
question, the add-to-cart outcome measure, the removal of installment detection, and the card
and popup fixes below. Uploading it, and replacing the listing's screenshots and promo tiles, is
a person's job: [STORE-LISTING.md](STORE-LISTING.md) has the copy and the checklist.

The privacy policy is live at <https://viditchhajed.github.io/pensa-docs/privacy.html> and is
generated verbatim from [PRIVACY.md](PRIVACY.md), so the published and committed copies cannot
drift. The older `vero-docs` address redirects to it, because the listing still points there
until 1.1.0 is published.

| | |
|---|---|
| Patterns shipped | **19**, 13 on-page + 2 cross-stage + 4 derived from visit history |
| Unit tests | 633, plus the recall eval |
| Real-browser e2e | 59 passing, 3 skipped (sites unreachable from this network) |
| Bundle | 234 KB gzipped across all bundles, but the number that matters is the content script on every page load: **32 KB**. The service worker is 183 KB, most of it the Public Suffix List that names shops correctly, loaded once per worker wake and never in a page |
| `host_permissions` | `https://*/*`, granted at install, with banking/health/government/webmail excluded in two layers |
| Network requests | **zero unless sharing is switched on**, asserted against the compiled bundles; with it on, the only address that can be contacted is the declared endpoint, also asserted. Sharing is off until answered, and a plain `npm run build` compiles the send path out entirely |
| Card placement | 12/12 samples across 4 live retailers × 3 scroll depths |
| Detector recall | measured against 29,742 label rows over 4,957 distinct snippets from 44 shops, `npm run eval:detectors`. The corpus itself is **not distributed** (it is real retailer page text); see [CORPUS.md](CORPUS.md) to rebuild it, and `tests/eval/baseline.json` for the committed numbers |
| Precision | 157 firings across 22 live sites, read claim by claim, [EVAL.md](EVAL.md). Across three runs 29 wrong claims were found and fixed, each with a regression test. Plus 0 confirmed false positives in ~44 hand-checked firings across 6 retailers. That audit predates 1.1.0, which removed a detector and changed the card's timing but no detector's scoring |

**On the page (13):** `anchoring.reference_price`, `pricing.charm`, `scarcity.stock`,
`urgency.countdown`, `defaults.preselected`, `social_proof.live_activity`,
`confirmshaming.decline_copy`, `goal_gradient.threshold`,
`interference.visual_asymmetry`, `decoy.asymmetric_dominance`, `nagging.repeat_interstitial`,
`framing.savings_ratio`, `loss_aversion.exit_intent`

Installment framing (`bnpl.installments`) was removed in 1.1.0. Splitting a small price into
payments changes nobody's decision, and pay-later options often genuinely help people; a card
questioning them was noise at best.

**Across a checkout flow (2):** `pricing.drip`, `basket.sneak`, these live in the service
worker and take a session ledger rather than a page, so they are not in the content-script
registry.

**Across repeat visits (4):** `temporal.evergreen_countdown`, `temporal.stock_nonmonotonic`,
`temporal.reference_price_ungrounded`, `temporal.social_proof_synthetic`, claims about how
something *changed* between visits, so they are derived in the worker from the observation
store and cannot be page detectors. They say nothing on a first visit, by construction.

Tier 2 and the temporal set were originally held for v1.1 (plan §13). That boundary moved
deliberately: both were built and tested alongside Tier 1, and the spot-check made the cost
concrete, flyfrontier's fare grid is a textbook asymmetric-dominance decoy and the extension
produced zero detections on it, because the only detector that could see it was excluded from
the bundle. `tests/unit/scope.test.ts` now asserts the shipped set is *present* in the built
bundles, and that the temporal four are in the worker and never in the page registry.

`src/shared/classifier.ts` is unwired scaffolding with no trained weights. It ships nothing,
and a test asserts its identifiers are absent from the build, a partially-trained classifier
scoring real pages would be worse than no classifier.

### Measured on real copy

`npm run eval:detectors` runs the shipped detectors over 4,957 labelled snippets collected
from 44 shops and reports precision and recall per pattern. Before that instrument existed,
every number this project had came from fixtures written against lexicons written from the
same imagination, they agreed with each other and with nothing else.

| pattern | recall | precision | |
|---|---|---|---|
| `goal_gradient.threshold` | 0.72 | 0.98 | |
| `urgency.countdown` | 0.71 | 0.92 | |
| `social_proof.live_activity` | 0.58 | 1.00 | |
| `scarcity.stock` | 0.54 | 1.00 | |
| `confirmshaming.decline_copy` | n/a | n/a | not measurable by this harness; see below |

Against the first measurement, before any of this was rewritten:

| pattern | was | now |
|---|---|---|
| `goal_gradient.threshold` | 0.04 | **0.72** |
| `urgency.countdown` | 0.11 | **0.71** |
| `social_proof.live_activity` | 0.00 | **0.58** |
| `scarcity.stock` | 0.43 | **0.54** |

Precision was not traded for it, it sits between 0.92 and 1.00, and every one of those
rewrites was driven by real copy the corpus produced rather than by phrasings anyone imagined.

Those are at the LOG threshold, what gets counted. The surface threshold, which is what
interrupts anyone, is far stricter and its precision is 1.00 across the board.

Read them as **agreement, not correctness**: the labels were produced by a model, not a
person, so a detector agreeing with them is not the same as being right. They support "this
change made it worse", which is the property worth having while lexicons are rewritten, 
`tests/eval/baseline.json` is a ratchet and a regression past 0.02 fails.

**`confirmshaming` cannot be measured here, and that is the harness, not the detector.**
Every snippet is rendered as a plain `<div>`, and confirmshaming requires its node to be a
decline CONTROL, it correctly declines to fire on a div. Checked separately: all three of
the corpus's instances ("I Will Pay Full Price!", "I don't want my mystery offer", "NO
THANKS, I'LL RISK IT") score 1.00 wrapped in a `<button>`. Reporting it as 0.00 would send
the next reader to fix something that already works.

The structural detectors, `anchoring`, `charm`, `defaults`, `interference`, `decoy`, are
NOT covered by this either, and that is now measured rather than assumed. The labelling flagged
**163** snippets as reference-price anchoring, which is more evidence than any of the six
text patterns had. **Zero** of them carry a strikethrough in the corpus.

They are not mislabelled. The harvested node is the container, "EGOWide Leg Low Rise
Trousers£21.60£27.00-20%", and the `<s>` sits on a child the corpus flattens away, so the
style recorded is the wrapper's. Measuring these needs the subtree, not the text, which is a
different collection format and a different privacy question: storing DOM structure from real
pages is a bigger commitment than storing scrubbed sentences.

Worth doing, not done, and the 163 labels are already sitting in `corpus/auto/` for whoever
does it.

### Known gaps, not claimed as done

- **Precision is measured on firings, not on experience.** An automated audit
  (`npm run spot:check`) drove this build over 64 pages on 22 live sites and every claim was
  adjudicated one at a time ([EVAL.md](EVAL.md)). It found 29 wrong claims, all now fixed and
  regression-tested, and it is the reason four detectors and the shared money parser changed
  before launch. But it reads
  the detector's own log rather than the card, so it cannot tell you that a claim was
  technically true and useless to a shopper, the failure that actually drives uninstalls.
  The hand pass plan §10 asked for (30–40 pages, judging each card) has **not** been run
  against this build; what has is 6 retailers and ~44 firings with zero confirmed false
  positives. Every threshold is still a hand-set guess, marked `confidenceBasis: "hand_set"`
  so it cannot be mistaken for a calibrated value. **No stronger precision claim than the one
  in the table above may be made anywhere.**
- **`framing.savings_ratio` ships unproven.** After its fix it produced no firings at all
  across those 22 retailers. Its unit tests show it still fires on the textbook shapes, but a
  quiet report means unproven, not working.
- **Recall is unmeasured, and is the weaker side.** The §10 gate was built to catch a detector
  crying wolf. Nothing is crying wolf. What the spot-check actually surfaced was misses, which
  that gate cannot see.
- **Nothing asks for a permission at runtime any more.** The per-site grant flow this section
  used to describe is gone: the broad permission is granted by Chrome at install, and
  `permissions.request()` is not called anywhere. What still needs a person is the install
  experience itself, since Chrome's install warning cannot be driven by automation.
- **A dense page is read over several passes, not one.** The harvest phase is time-budgeted
  at 35 ms per pass, and newegg's ~3900 qualifying nodes do not fit. Computed style is
  memoised across passes and dropped only for subtrees the MutationObserver saw change (plan
  §18C), so each pass spends its budget on what the last one skipped: measured on newegg,
  coverage goes 1696 → 3456 → full, and after about 7 seconds no pass exceeds the budget at
  all. Within a single pass truncation still follows document order, and nodes that appeared
  or changed while you were looking are exempt from the budget because they carry the
  highest-value signals. Bounding boxes are re-read every pass and deliberately never cached
, they are viewport-relative, so a scroll would make a cached one wrong with no mutation to
  notice.
- **The sharing dataset is empty, and the measure it feeds is unvalidated.** The sink is
  deployed and verified end to end (below), but no consenting user has reported anything yet,
  so every research claim the project might make is still hypothetical. The add-to-cart
  outcome measure in particular has been tested against fixtures and a live round trip, never
  against real shopping.
- **The outcome measure is association, not effect.** It records which techniques were on
  screen before an add-to-cart click and whether the click happened, with a `_page` baseline
  row per view so a rate has a denominator. Pages that run a countdown differ from pages that
  do not in product, price and intent, and the baseline controls for the shop, not for any of
  that. `site_pattern_add_rate` reports a lift; nothing published from it may call that lift
  an effect. The outcome is also the CLICK, not a confirmed add: `TriggerWatcher` does not
  check whether the item reached the cart.
- **Two live-activity shapes are not detected at all.** "15 people have this in their cart"
  and "Sarah from Sydney just bought this" both score zero, found while testing 1.1.0. They
  are ordinary copy and the detector should see them; it does not.

## Sharing, and the dataset it feeds

Sharing is off until someone says yes. They are asked twice at most:

1. **At install.** `chrome.runtime.onInstalled` (fresh installs only) opens `welcome.html`: one
   card, one question, Yes or No, with the full disclosure behind "More details". Closing it
   answers nothing.
2. **On the first in-page card**, and only if the install card went unanswered. Same rules.

Both are built to the constraints Pensa's own detectors look for: the two answers are the same
control, nothing is preselected, nothing is focused, and no claim is made that sharing is risk
free. `tests/e2e/welcome.spec.ts` and `tests/unit/consentAsk.test.ts` assert those properties
rather than trusting them.

With sharing on, two kinds of record are queued, batched, and flushed on a six-hour alarm:

| | |
|---|---|
| **Prevalence** | which technique appeared on which shop, at which stage, on which day, with a confidence quartile. Eight fields |
| **Outcome** | per product or listing page view: one `_page` baseline row plus one row per technique that cleared the salience gate BEFORE the add-to-cart click, and whether that click happened. Seven fields |

Both record types are `.strict()` in the extension and re-validated field by field on the
server, so an accidentally added field is refused at both ends. The sink is deployed:
`server/` holds it, `pensa-counts.viditchhajed.workers.dev/counts` runs it, and the research
views (`site_prevalence`, `pattern_reach`, `pattern_by_stage`, `pattern_add_rate`,
`site_pattern_add_rate`) are in `server/cloudflare/schema.sql`. The `_public` views apply the
floor: a shop and technique pair is released only once 20 independent batches have reported
it. See [server/DEPLOY.md](server/DEPLOY.md) and [server/README.md](server/README.md).

A build only sends if `TELEMETRY_ENDPOINT` was set when it was compiled. A plain
`npm run build` has no endpoint and no send path at all, which is what the zero-egress tests
run against; the uploaded zip is built with it.

## Permissions

Three, plus one host permission granted at install:

| Permission | Why |
|---|---|
| `storage` | Settings, the local event log, the per-session ledger, and the queue of reports waiting to be sent |
| `activeTab` | Read the current tab's URL in the popup, so it can say what it is doing here |
| `alarms` | Three scheduled jobs: delete detections past the retention window, evict product history past 90 days, and send queued reports every six hours rather than at the moment something is found |
| `https://*/*` | The detector itself. Requested at install, with banking, health, government and webmail excluded in two layers |

`scripting` and `declarativeContent` are deliberately absent: the content script is declared
in the manifest rather than registered at runtime, and the toolbar action is enabled
everywhere, so neither permission would buy anything.

**Pensa requests `https://*/*` at install, and Chrome shows the "read and change all your
data on websites you visit" warning. That is accurate and it is deliberate.**

It did not start this way. The original design (plan §14.2) asked for one origin at a time
from the popup, which kept the permission narrow and made the tool close to useless: a
shopper had to already suspect a page before they could ask Pensa to look at it, which is
backwards for something whose whole job is to notice what you did not. And the list is
always wrong, these techniques run on small independent shops and regional storefronts as
readily as on the large retailers any list would name.

The permission is therefore broad, and the constraint lives in what the code does with it:

- **Banking, health, government and webmail are refused absolutely**, in two independent
  layers, excluded from the content script's match patterns so Chrome never injects there,
  and refused again at runtime before the script reads anything. The build fails if the
  denylist is empty.
- **`https` only.** Plain `http` is outside the requested permission.
- **Still no network request unless sharing is on**, asserted against the compiled bundles.
  Broad read access and egress are independent questions: the permission grew, what leaves
  the device did not, and it leaves only after an explicit yes.
- **A page where nothing is found leaves no record.** Permission to read is not a log.

## Architecture

Detectors are **pure functions**: `(ctx: PageContext) => DetectionCandidate[]`. They never
touch the DOM, never mutate state, never call the network. Every DOM read happens in one
batched phase before any detector runs, which makes layout thrashing structurally impossible
rather than merely discouraged, and means the same detector bundle can run in Node against a
serialized DOM.

```
src/
  shared/      schema (Zod), taxonomy, money (bigint minor units), url scoring, messages
  content/     harvest (read phase) -> detectors (pure) -> salience -> ui/card
  background/  session ledger, digest ranking, cross-stage + temporal claims,
               outcomes (add-to-cart measure), telemetry queue, Dexie store
  entrypoints/ background (SW), detector (unlisted script), popup, options, welcome
rulepacks/     allowlist + denylist, as data
server/        the counting sink: handler.ts (host-agnostic) + cloudflare/ (Worker, D1 schema)
store/         listing copy, screenshots, promo tiles
```

Three things live in the worker rather than the page, because they outlive any one page load:
the session ledger the cross-stage detectors read, the digest decision (ranking, frequency,
and which card to show), and the open page views the outcome measure closes at add-to-cart.

`src/shared/taxonomy.ts` is the bridge between the code and the write-up: every pattern
carries its mechanism, its primary citation, and a severity weight.

## Development

```bash
npm install
```

```bash
npm run build
```

Then load `.output/chrome-mv3` as an unpacked extension at `chrome://extensions`. A fresh load
counts as an install, so the welcome card opens.

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run compile
```

The build that gets uploaded is the only one that can send anything, so it is built
deliberately:

```bash
TELEMETRY_ENDPOINT=https://pensa-counts.viditchhajed.workers.dev/counts npm run zip
```

Listing images: `npm run screenshots` writes `store/screenshots/01..04`, and
`npx playwright test tests/e2e/welcome.spec.ts` writes `05-welcome.png`.

## Things worth knowing before changing this

- **`host_permissions` must be exactly `["https://*/*"]`.** Not `<all_urls>`, not
  `*://*/*`, not `http://*/*`. The build throws otherwise, and `tests/unit/manifest.test.ts`
  guards it. The point of the assertion is no longer to keep the permission small, that
  argument was lost on purpose, but to keep `http` and non-web schemes out of it.
- **The denylist is the load-bearing control now, so it must never be allowed to become
  empty.** It is enforced twice, and the build fails if it is empty. Anything that weakens
  it is a bigger change than it looks, because it is the only thing standing between a broad
  permission and a bank's page.
- **The overlay must never cover a checkout button.** `pointer-events: none` on the host is
  necessary but not sufficient, the card re-enables them. Placement is chosen by rectangle
  intersection against every interactive element in the viewport. See
  `tests/unit/card-position.test.ts`, which encodes a failure found in a real browser.
- **Prices are bigint minor units, never floats.** Reconciliation is
  `total − Σ(items)`; float error there manufactures phantom fees.
- **A card is not shown until a page says it stayed up.** On a site whose Add to Cart
  navigates to a cart page, the card is built for a page that is already being torn down. The
  worker holds each card for 60s and only forgets it when a page reports it survived 1.5s on
  screen; otherwise the next page on that shop collects and shows it. Changing either timing
  means changing `tests/e2e/card-after-navigation.spec.ts`, which covers both the carry-over
  and the no-duplicate case.
- **The card debounce is per page, not per shop.** One card per origin, stage and product
  identity per session on the default setting. It used to be per origin and stage, which meant
  the first card on a shop silenced every later add-to-cart there for the rest of the day.
- **No em dashes.** House style, enforced by `tests/unit/copy-lint.test.ts`. The only ones left
  are inside regex character classes that match retailer text, and two test inputs quoting real
  shop copy.

## Privacy

Nothing leaves the device unless sharing is switched on, and Pensa asks about that once, at
install. What a report may carry, and what it may never carry, is in
[PRIVACY.md](PRIVACY.md), which is the source for the published policy.
