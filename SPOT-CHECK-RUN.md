# Spot-check run, 2026-09-29

The §10 human pass. Fill this in as you go; leaving it to memory afterwards is how a run
becomes anecdote. Two columns are the whole point of doing this by hand:

- **True?** Did the page actually display that? (A real "only 2 left" IS true, even if the
  shop is manipulating you with it. False means the page did not show it at all.)
- **Worth it?** Would this have been worth interrupting you for? This is the column no
  automated pass can produce, and the one that decides what ships.

## Before you start

- [ ] `chrome://extensions`: remove every other Pensa entry, load `.output/chrome-mv3-live`
- [ ] Answer **Yes** on the install card
- [ ] Service worker console (`Inspect views: service worker`), paste this and confirm the
      reply line says `no_endpoint` is NOT the reason:
      `chrome.alarms.create("telemetry", { when: Date.now() + 500 })`
      Expect `[pensa] telemetry: too_small, 0 sent, N held` early on. `too_small` is fine.
      `no_endpoint` or `no_consent` means stop and fix before spending the hour.
- [ ] Note the start time here: ______

## Rules

Add to cart freely. Do not place an order, do not create an account, do not enter payment
details. Stop at the first sign-in or payment step. Decline cookie banners.

## What to do on each shop

1. Open a **product page** and let it sit ~10 seconds. The salience gate needs 800ms of real
   on-screen time, and the page has to be the visible tab.
2. **Add to cart.** Watch for the card. On shops that jump to a cart page, it should appear
   there instead within a second or two.
3. Open the **cart**, then start checkout as far as sign-in or payment, and stop.
4. Log every card below. Also log anything obvious the page showed that produced NO card.

## Cards I was shown

| # | Shop | Stage | Pattern(s) on the card | True? | Worth it? | Note |
|---|------|-------|------------------------|-------|-----------|------|
| 1 |      |       |                        |       |           |      |
| 2 |      |       |                        |       |           |      |
| 3 |      |       |                        |       |           |      |
| 4 |      |       |                        |       |           |      |
| 5 |      |       |                        |       |           |      |
| 6 |      |       |                        |       |           |      |
| 7 |      |       |                        |       |           |      |
| 8 |      |       |                        |       |           |      |

## Misses: obvious techniques that produced no card

| # | Shop | What was on screen (quote it) | Where | Card? | Row in Settings? |
|---|------|-------------------------------|-------|-------|------------------|
| 1 |      |                               |       |       |                  |
| 2 |      |                               |       |       |                  |
| 3 |      |                               |       |       |                  |

## Anything that felt wrong

Placement, timing, wording, a card that covered something, a card that arrived too late to
matter, a question that read as accusing the shop. Free text:

-

## Coverage

Aim for 6+ shops across categories. Travel and ticketing are the densest and were silent for
a whole build once, so do not skip them.

- [ ] ota_travel: booking.com or expedia.com
- [ ] ticketing: ticketmaster.com or eventbrite.com
- [ ] fast_fashion: shein.com or asos.com
- [ ] marketplace: amazon.com or etsy.com
- [ ] big_box: target.com or bestbuy.com
- [ ] dtc: glossier.com or allbirds.com (the negative control: firing a lot here is suspicious)

## After the hour

- [ ] Settings, **Export my data**, save the JSONL (that captures every detection, so your
      notes above only need the judgement columns)
- [ ] Service worker console: `chrome.alarms.create("telemetry", { when: Date.now() + 500 })`
- [ ] Tell me, and I will read the export, query Cloudflare, and tally the run into EVAL.md
