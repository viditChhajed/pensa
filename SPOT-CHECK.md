# Spot-check guide, the two things only you can do

Both need a human at a real Chrome window. Neither can be automated: one is the install
experience Chrome renders outside the page, the other is a judgement call about whether a
detection was correct and, harder, whether it was worth making.

Start here:

```bash
npm run build
```

Then load `.output/chrome-mv3` unpacked at `chrome://extensions` with Developer mode on.

---

# A. Install and first-run check (~5 minutes)

There is no per-site enablement any more: the broad permission is granted by Chrome at
install, and nothing calls `permissions.request()`. What a person still has to look at is the
install card Chrome opens on top of that, and the three states the popup can report.

### Steps

1. Load the unpacked build. A tab opens with the install card.

   ### ✅ PASS: one question, `✓ Yes` and `✕ No` the same size, nothing preselected, **More details** collapsed
   ### ❌ FAIL: anything preselected, or one answer louder than the other

2. Click **More details**. It should say what a report carries and what it never carries,
   in place, without leaving the card. Answer either way; Settings should agree with it.

3. Go to **https://www.etsy.com** and open a product page. Click the toolbar icon.

   ### ✅ PASS: "Pensa is checking etsy.com."
   ### ❌ FAIL: "idle" on an obvious product page. Read the page's console: the commerce gate logs its score and every signal it found.

4. Open `chrome://extensions` → **Inspect views: service worker** → Application → Storage →
   Extension storage → Session.

   ### ✅ PASS: a key like `ledger:https://www.etsy.com` exists
   ### ❌ FAIL: no such key, which means nothing was ever reported to the worker

### Also worth 60 seconds

| Site | Expect in the popup | Why |
|---|---|---|
| https://www.wikipedia.org | "Pensa is idle on wikipedia.org." | not a shop, and nothing is recorded |
| https://www.etsy.com | "Pensa is checking etsy.com." | a shop |
| https://www.chase.com | "Pensa does not run on www.chase.com." | denylist, enforced in two layers |

The Chase case is the important one, and the check is that **no `ledger:` key exists for it**.
The denylist is applied before any commerce score, and the content script refuses to run at
all on those hosts, so a page there should leave no trace whatsoever.

**Report back:** the four steps above, and the three popup states.

---

# B. 30–40 page spot-check (~90 minutes)

This is plan §10, and it is the gate that unblocks everything else. Thresholds and
default-enable/disable decisions are waiting on these numbers.

Record every firing in [EVAL.md](EVAL.md), the table is already laid out with the exact
columns.

### Target coverage

**≥6 retailers across ≥6 categories, 30–40 pages total.** Breadth beats depth: five pages on
one site teaches less than one page on five sites.

Categories are the allowlist's own (`rulepacks/allowlist.v1.json`). That list no longer
decides where Pensa runs, it only tags a shop's category for the dataset, so any shop is fair
game; these are simply dense ones:

| Category | Suggested | Why it earns a slot |
|---|---|---|
| **ota_travel** | booking.com, expedia.com | Highest known pattern density. Scarcity, urgency, live activity, drip fees, all at once. **Do not skip.** |
| **ticketing** | ticketmaster.com, stubhub.com | The reference case for fees first disclosed at payment, the single strongest finding the tool can produce. |
| **airline** | spirit.com, frontier.com | Drip pricing and preselected add-ons, by design. |
| **fast_fashion** | shein.com, asos.com | Countdown timers, stock counters, live-activity toasts. |
| **food_delivery** | doordash.com, ubereats.com | Fee stacking disclosed late. |
| **marketplace** | amazon.com, etsy.com | Baseline. Dense pages, a good stress test for false positives. |
| **big_box** | target.com, bestbuy.com | Preselected protection plans at checkout. |
| **electronics** | newegg.com, bestbuy.com | Warranty add-ons, decoy bundles. |
| **dtc** | glossier.com, allbirds.com | Cleaner design, useful *negative* control. If detectors fire here, suspect noise. |
| **subscription_box** | hellofresh.com, chewy.com | Goal-gradient thresholds, auto-renew defaults. |

Six is the minimum. If you only have time for six, take: **ota_travel, ticketing, airline,
fast_fashion, marketplace, dtc**, the first four for density, marketplace for stress,
and dtc as the negative control.

### What to do on each retailer

1. Open a **product page**. Nothing to enable: Pensa runs on every https page it is not
   forbidden.
2. Let it sit ~10 seconds so dwell accrues (the salience gate needs 800 ms of real on-screen
   time before anything can surface).
3. **Add to cart.** Watch for the card. On a shop that navigates to a cart page rather than
   opening a drawer, the card should appear there instead, within a second or two.
4. Go to the **cart**.
5. Proceed toward **checkout** as far as you can *without paying and without creating an
   account under false information*. Stop at payment entry.
6. Open **Settings → What was noticed today** and log every row.

### Rules of judgement

The single call that matters most, and the easiest to get wrong:

> **The tool reports what a page displayed. It never claims the message was untrue.**

So "Only 2 left" on a page that genuinely had 2 left is **correct**, not a false positive.
A false positive is when the page did not display that pattern at all, e.g.
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
