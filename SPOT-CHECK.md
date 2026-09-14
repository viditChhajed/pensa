# Spot-check guide — the two things only you can do

Both need a human at a real Chrome window. Neither can be automated: one raises a native OS
dialog, the other is a judgement call about whether a detection was correct.

Start here:

```bash
npm run build
```

Then load `.output/chrome-mv3` unpacked at `chrome://extensions` with Developer mode on.

---

# A. Permission-gesture check (~5 minutes)

This is plan §1.4 / step 1d. `chrome.permissions.request()` raises a **native OS dialog**,
which lives outside the page DOM, so no automation can accept it. It is the one link in the
grant chain that has never been verified.

### Steps

1. Go to **https://www.etsy.com** (on the allowlist).
2. Look at the toolbar icon.
   - **Expect:** full colour.
   - *If grey:* the declarativeContent rules did not install. Check the service worker
     console for errors.
3. Click the icon. The popup opens and should say *"www.etsy.com looks like a shopping site."*
4. Click **Enable on this site**.

   ### ✅ PASS — Chrome's permission prompt appears immediately
   ### ❌ FAIL — no prompt appears

   A failure here means an `await` crept in ahead of `permissions.request()` and consumed the
   user gesture. The popup resolves the origin when it *opens*, precisely so the click
   handler can stay synchronous. Culprit would be
   [src/entrypoints/popup/main.ts](src/entrypoints/popup/main.ts).

5. Click **Allow**, then reload the Etsy page.
6. Open `chrome://extensions` → **Inspect views: service worker**.

   ### ✅ PASS — no `[vero] content script registration failed`
   ### ❌ FAIL — that error appears

7. In that same inspector: **Application → Storage → Extension storage → Session**.

   ### ✅ PASS — a key like `ledger:https://www.etsy.com` exists
   ### ❌ FAIL — no such key

   This is the silent failure the plan warns about (§1.3): registration succeeding is **not**
   injection. A registered script stays inert without permission, and the no-op looks exactly
   like "the detector found nothing."

### Also worth 60 seconds

| Site | Expected icon | Why |
|---|---|---|
| https://www.wikipedia.org | **grey** | not commerce |
| https://www.etsy.com | **colour** | allowlisted |
| https://www.chase.com | **grey, and the popup must refuse to offer enablement** | denylist |

The Chase case is the important one. A permission prompt on a bank is the worst outcome this
product can produce, so the denylist is checked *before* any commerce score and cannot be
overridden by one.

**Report back:** pass/fail for step 4, step 6, step 7, and the three icon states.

---

# B. 30–40 page spot-check (~90 minutes)

This is plan §10, and it is the gate that unblocks everything else. Thresholds and
default-enable/disable decisions are waiting on these numbers.

Record every firing in [EVAL.md](EVAL.md) — the table is already laid out with the exact
columns.

### Target coverage

**≥6 retailers across ≥6 categories, 30–40 pages total.** Breadth beats depth: five pages on
one site teaches less than one page on five sites.

Categories are the allowlist's own (`rulepacks/allowlist.v1.json`). Suggested sites, all on
the allowlist so enablement is one click:

| Category | Suggested | Why it earns a slot |
|---|---|---|
| **ota_travel** | booking.com, expedia.com | Highest known pattern density. Scarcity, urgency, live activity, drip fees, all at once. **Do not skip.** |
| **ticketing** | ticketmaster.com, stubhub.com | The reference case for fees first disclosed at payment — the single strongest finding the tool can produce. |
| **airline** | spirit.com, frontier.com | Drip pricing and preselected add-ons, by design. |
| **fast_fashion** | shein.com, asos.com | Countdown timers, stock counters, live-activity toasts. |
| **food_delivery** | doordash.com, ubereats.com | Fee stacking disclosed late. |
| **marketplace** | amazon.com, etsy.com | Baseline. Dense pages — a good stress test for false positives. |
| **big_box** | target.com, bestbuy.com | Preselected protection plans at checkout. |
| **electronics** | newegg.com, bestbuy.com | Warranty add-ons, decoy bundles. |
| **dtc** | glossier.com, allbirds.com | Cleaner design — useful *negative* control. If detectors fire here, suspect noise. |
| **subscription_box** | hellofresh.com, chewy.com | Goal-gradient thresholds, auto-renew defaults. |

Six is the minimum. If you only have time for six, take: **ota_travel, ticketing, airline,
fast_fashion, marketplace, dtc** — the first four for density, marketplace for stress,
and dtc as the negative control.

### What to do on each retailer

1. Enable the site from the popup.
2. Open a **product page**. Let it sit ~10 seconds so dwell accrues (the salience gate needs
   800 ms of real on-screen time before anything can surface).
3. **Add to cart.** Watch for the card.
4. Go to the **cart**.
5. Proceed toward **checkout** as far as you can *without paying and without creating an
   account under false information*. Stop at payment entry.
6. Open **Settings → What was noticed today** and log every row.

### Rules of judgement

The single call that matters most, and the easiest to get wrong:

> **The tool reports what a page displayed. It never claims the message was untrue.**

So "Only 2 left" on a page that genuinely had 2 left is **correct**, not a false positive.
A false positive is when the page did not display that pattern at all — e.g.
`scarcity.stock` firing on "2 sizes left" (genuine variant availability), or
`urgency.countdown` firing on store opening hours.

Log misses too. A detector that never fires on booking.com is telling you something.

### Do not

- Place a real order.
- Create an account with false information.
- Enter payment details anywhere.

### What I do with the numbers

Per plan §10: any detector with **more than ~4 false positives** out of its firings gets its
threshold raised or gets **default-disabled**. Disabling a noisy detector is a normal
outcome. Hand me the filled-in EVAL.md and I will make those changes and report which
detectors moved.
