# Manual verification checklist

Everything machine-verifiable runs in `npm run test:e2e` (real Chromium, real extension, 59
tests, 3 skipped). What is left here is what a machine cannot judge: the install experience Chrome
renders outside the page, and whether a card was *useful* rather than merely correct.

```bash
npm run build
```

Then load `.output/chrome-mv3` unpacked at `chrome://extensions` with Developer mode on. A
fresh load counts as an install, so the welcome card should open by itself.

## 1. The install experience, REQUIRES A HUMAN

Chrome's own install warning ("Read and change all your data on all websites you visit") is
rendered by the browser, not the page, so no automation can see or accept it. The card that
follows is automated (`tests/e2e/welcome.spec.ts`), but it is worth seeing once in a real
window.

1. Load the unpacked build. A tab opens with the install card.

   **PASS:** one card, one question, `✓ Yes` and `✕ No` the same size, nothing preselected,
   and **More details** collapsed.
   **FAIL:** a preselected answer, one button louder than the other, or the details expanded
   by default. Any of those is the extension doing what it exists to point out.

2. Click **More details**. It should say what a report carries and what it never carries,
   without leaving the card.

3. Answer **No**, then open Settings.

   **PASS:** "Help measure these techniques" is unticked.
   Answer **Yes** on a second fresh profile instead and it should be ticked.

4. Close the card without answering on a third profile, then shop until a card appears.

   **PASS:** the sharing question appears at the bottom of that first card, asked once.

## 2. Popup states, three of them

The toolbar icon is always enabled now; there is no per-site enablement and no greyscale
rule. What changes is what the popup says.

| Site | Expect |
|---|---|
| `https://www.etsy.com`, on a product page | "Pensa is checking etsy.com." |
| `https://www.wikipedia.org` | "Pensa is idle on wikipedia.org." and a line saying it is not recording |
| `https://www.chase.com` | "Pensa does not run on www.chase.com." and "This site is on Pensa's permanent exclusion list." |

The Chase case is the important one: the denylist is enforced before any commerce score and
cannot be overridden by one. Confirm there is no `ledger:https://www.chase.com` key under
`chrome://extensions` → Inspect views: service worker → Application → Storage → Extension
storage → Session. On Etsy that key should exist.

## 3. Real-retailer spot-check (plan §10), AUTOMATED PASS DONE, HUMAN PASS NOT RUN

30 to 40 pages across at least 6 retailers, hand-tallying each detector's firings as correct
or incorrect. Any detector with more than ~4 false positives gets its threshold raised or is
disabled by default. Record the tally in [EVAL.md](EVAL.md); [SPOT-CHECK.md](SPOT-CHECK.md)
has the protocol and the site list.

**An automated pass exists and has run.** `npm run spot:check` drives the real build over
live retailer pages and records every firing with the text it matched; the tally is in
EVAL.md. It caught false positives the labelled corpus could not, and it is the reason four
detectors and the shared money parser changed before launch.

It is **not** this section. The automated pass reads the detector's own log; a person reads
the page. It cannot tell you that a claim was technically true and still useless to a shopper,
the failure that actually drives uninstalls, and it never sees the card, only the firing
behind it. So what stands:

- A precision claim about *firings*, from the automated pass, is supported, and is stated in
  EVAL.md with that provenance attached.
- A claim about what the extension is like to *use* is not, until a human does this pass.

Thresholds remain hand-set guesses either way, marked `hand_set` in the schema so they cannot
be mistaken for calibrated values.

## 4. Egress, by eye

With sharing **off** (answer No at install), browse a full session with DevTools → Network
open, filtered to the extension. Expect **zero** outbound requests. This is the load-bearing
claim in PRIVACY.md and it is worth seeing rather than inferring from the absence of `fetch`
calls in the source.

With sharing **on**, the only address that may ever appear is the endpoint the build was
compiled with. Reports go out on a six-hour alarm, never at the moment something is found, so
expect to see nothing at all during a short session. To force one:
`chrome.alarms.create("telemetry", { when: Date.now() + 500 })` in the service worker console.

## 5. The two cards that are easy to get wrong

- **A navigating Add to Cart.** On a shop whose Add to Cart loads a cart page rather than
  opening a drawer, the card must still appear, on the cart page. Automated in
  `tests/e2e/card-after-navigation.spec.ts`, but worth seeing once on a real shop.
- **A second product on the same shop.** On the default frequency setting, adding a different
  product should produce its own card. A second add on the *same* product page should not.

---

## What IS automated

`npm run test:e2e`, real Chromium, real extension, 59 passing (3 skipped where a live site is
unreachable from this network):

- service worker boots; the manifest **as Chrome parsed it** asks for exactly `https://*/*`
  and carries the denylist as `exclude_matches`
- the content script is declared, and **injection is proven separately from declaration**
  (via a worker-visible side effect, since content scripts run in an isolated world)
- a fresh install opens the welcome card; answers are recorded; the two answers are the same
  control and nothing is preselected
- popup and options pages render every control; the sharing checkbox is unticked by default
- the card renders on a real drawer, survives an Add to Cart that navigates away, and is not
  shown twice
- the overlay survives 3 hostile CSS regimes, including one that tries to hide it by id and
  id-prefix, and never wins the hit test over a checkout button
- browsing records what a shop displayed, once per piece of copy, without a card
- add-to-cart outcomes reach the sink as seven-field rows, through the shipped server handler
- zero outbound requests with sharing off; with it on, only the declared endpoint
- deleting all data empties IndexedDB; the retention alarm prunes; switching sharing off
  empties the queue

`npm run build` fails on a host pattern other than `https://*/*`, on an empty denylist, or on
a content script declared without `exclude_matches`.
