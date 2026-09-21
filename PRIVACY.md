# Privacy Policy — Pensa

**Last updated: 2026-09-18**

## The short version

By default this extension sends nothing anywhere. It has no analytics and no account, and with
the default settings it makes no network requests of any kind. Everything it notices about a
page is processed on your device and stays on your device.

The one exception is a setting you have to switch on yourself: sharing which shops use which
techniques, and whether you added the item to your cart after seeing them, described in full
below. It is off unless you turn it on. Pensa asks you about it once, on the first card it shows
you; closing that card without answering counts as no.

With sharing off, nothing reaches any server — that is what the "zero outbound requests" test
asserts against the compiled extension. With sharing on, reports go to exactly one address, a
counting service run by this project whose source is in the public repository's `server/`
directory, so what it accepts and stores can be read rather than trusted.

You can verify this rather than take our word for it: open DevTools, go to the Network tab,
and browse with the extension enabled and sharing off. There will be no requests from it.

## What the extension does

On the https sites where it runs, it reads the page to notice persuasion techniques —
countdown timers, limited-stock messages, crossed-out reference prices, preselected
checkboxes, and similar. When you add something to a cart or begin checkout, it may show a
small card with a question about what it noticed.

On any page with nothing to notice, it notices nothing and shows nothing. Shopping pages are
not a list it holds; they are simply the pages where these techniques appear.

## What it stores, and where

Everything below is stored only on your device, in your browser's extension storage, and only
for pages Pensa has decided are shops. A page that is not a shop is never recorded.

**Detections** — kept 30 days by default (adjustable in Settings):

- The pattern type, a confidence number, how long the element was on screen and how much of the
  screen it filled, and the stage of checkout you were at.
- The site's origin (for example `https://www.example.com`) and a redacted path shape (for
  example `/products/:slug`).
- A one-way hash of the matched text, plus a short excerpt of that text (up to 240 characters) so
  you can see what was matched. On a checkout page, text near a matched element can include
  whatever that page displays, so an excerpt could in principle contain details shown there.

These are recorded as you browse shops — when Pensa notices something, it writes down what the
page displayed — and again when you add something to your cart or head to checkout, which is
when it may also show you a card. Each distinct piece of copy is recorded once per page, not
once per second, and a page it finds nothing on produces nothing.

**Product history** — kept up to 90 days, at most 5,000 products:

- For products you view on shops: an identifier for the product (its SKU or barcode where the
  page provides one, otherwise a one-way hash of its address and title), the prices and "was"
  prices shown, stock counts, countdown end times and viewer counts, each with the time seen.
- This is what lets Pensa notice a countdown that resets, a stock count that goes back up, or a
  "was" price that is never actually charged. It is a record of which products you looked at on
  which shops, and it never leaves your device.

**This browsing session** — cleared when you close the browser:

- For each shop: which checkout stages you reached, and the prices on each — item price,
  subtotal, shipping, tax, total, and fee or add-on lines with their labels.
- The label of any add-to-cart button you clicked, and which kinds of add-on you chose or
  declined yourself (for example "gift wrap: chosen"). This is what stops Pensa reporting an
  add-on you picked as one you did not.

**Open page views, only while sharing is on** — at most 30 minutes each:

- For a product or listing page you are looking at: the shop, whether it is a product or
  listing page, and which techniques have been on screen so far. This is how Pensa knows, when
  you click Add to Cart, what you had seen before deciding. It is turned into the reports
  described below when you click Add to Cart or after 30 minutes without activity, then
  deleted. Nothing is held while sharing is off, and switching it off deletes anything held.

**Settings** you choose, until you change them.

You can export or delete everything from the Settings page ("Export my data", "Delete all my
data").

## What it never stores or transmits

- Full URLs or query strings.
- Anything you type into a page — searches, addresses, messages, payment details.
- Your name, email, phone number, or any account identifier, other than where one appears in
  on-page text near a matched element, as described above.
- Anything at all about pages that are not shops.
- Any of the above, off your device, unless you switch on sharing — and even then only the
  fields listed in that section.

## Site permissions

**Pensa asks for access to all https websites at install time, and Chrome will tell you so in
those words.** You should read that warning as accurate: the permission is broad, and it is
granted the moment you install rather than site by site.

This is a deliberate change from how Pensa previously worked, and it is worth being plain
about the trade. The earlier design asked for one site at a time, which made the permission
narrow and the tool nearly useless — a shopper had to already suspect a page before they
could ask Pensa to look at it, which is precisely backwards for a tool whose whole purpose is
to notice what you did not. Persuasion techniques are not confined to a list of large
retailers; they turn up on small independent shops, regional sites, and storefronts that did
not exist when any list was written. A fixed list is always wrong, and it is wrong in the
direction that leaves people unprotected.

So the permission is broad. What constrains it is not the permission; it is what the code
does with it, and that is public and testable:

- **Pensa never runs on banking, health, government, or webmail sites.** This is enforced in
  two independent layers: those hosts are excluded from the content script's match patterns,
  so Chrome does not inject Pensa there at all; and the script additionally refuses to run on
  any denied host before it reads anything. The list is in `src/shared/urlScore.ts` and the
  build fails if it is empty.
- **Only `https` sites.** Plain `http` pages are outside the requested permission entirely.
- **It sends nothing anywhere unless you switch sharing on.** Broad read access and network
  access are separate questions. With the default settings there are zero outbound requests,
  asserted against the compiled bundles by an automated test, not merely stated here.
- **It records nothing about a page that is not a shop.** Access to read a page is not a
  record of having read it. On shops, what it keeps is listed under "What it stores".

Pensa itself has no per-site off switch. You can turn detection off entirely, or switch off any
individual technique, from its Settings page. To keep Pensa off particular sites, use Chrome's
own control: open `chrome://extensions`, choose Pensa's Details, and set Site access to "On
specific sites" — Chrome then enforces that regardless of anything Pensa does. Uninstalling
removes the permission entirely.

## Optional: helping measure these techniques

There is a setting to share which shops use which techniques. **It is off by default and there
is no pre-checked box.**

**How you are asked.** Once, at the bottom of the first card Pensa shows you, after you have
seen what it does. The question says who builds Pensa, what the data is for, and what is shared,
in the question itself rather than behind a link. The two answers — "Yes, share" and "No
thanks" — are the same size and style, neither is selected for you, and closing the card
without answering is recorded as no. You are not asked again. You can change your answer at
any time in Settings. While it is off, nothing is transmitted and nothing is even recorded
for transmission — the queue is not filled and then withheld, because a queue that accumulates
while you have said no is one that would empty the moment you said yes.

**If you switch it on, it names the shop.** That is its purpose: to build a picture, shop by
shop, of how often these techniques are used. A report says *"someone saw a countdown on
shein.com today."* It is sent to a server run by this project and stored there.

There are two kinds of report.

**1. What a shop showed.** Each carries exactly eight fields and no others:

| | |
|---|---|
| pattern type | e.g. `scarcity.stock` |
| detector id | which rule matched |
| confidence quartile | 1–4, never the score |
| funnel stage | browse / product / cart / checkout / payment |
| **shop** | the main domain only, e.g. `shein.com` — never `us.shein.com/products/123` |
| shop category | e.g. `fast_fashion`, or `other` |
| rule pack version | |
| **day** | the date, never a time |

**2. Whether an item was added to the cart.** On product and listing pages only. When you leave
such a page, or click Add to Cart on it, Pensa sends one report saying whether you clicked Add to
Cart, plus one more for each technique that was on screen *before* you decided. Each carries
exactly seven fields and no others:

| | |
|---|---|
| pattern type | e.g. `urgency.countdown`, or `_page` for the page itself |
| funnel stage | listing or product page only |
| **shop** | the main domain only, e.g. `shein.com` |
| shop category | e.g. `fast_fashion`, or `other` |
| rule pack version | |
| **day** | the date, never a time |
| **added to cart** | yes or no |

"Added to cart" means you clicked an Add to Cart button, not that the item was actually added —
Pensa does not check. A page's reports are sent as separate counts, never as a list of what one
page showed together, because that combination could identify the page. Nothing about the item
is included: not its name, price, or address.

This measures association, not effect. It can say that product pages showing a countdown on a
given shop were followed by an add some share of the time, compared with that shop's pages
overall. It cannot say the countdown caused the difference, and nothing published from it will
claim that.

Never included in either kind: the page, the product, the search, the path or the full web address; any page
text or prices; your account, name, email, or any identifier for you or your browser; and any
time more precise than the day. The record type is declared `.strict()` in the extension and
the server independently rejects any report with a field outside that list, so an accidentally
added field is refused at both ends rather than stored.

The limits, each enforced in code rather than promised here:

- **Only shops can be reported.** Pensa reads each page and decides whether it is selling
  something before it does anything else. A detection — and therefore a report — can only
  exist on a page that passed that check. A site you visit that is not a shop is never
  reported, whatever it is.
- **The day, not the time.** A shop plus an exact time is far easier to tie to one person's
  browsing than a shop plus a date, and measuring how common a technique is needs no more
  than the date.
- **Sent on a timer, never at the moment something is found.** Pensa checks every six hours and
  sends once at least 25 reports are waiting, or once the oldest has waited a day. So the
  timing of a request does not reveal when you were shopping.
- **One request carries one person's batch.** A batch can hold reports from several shops over
  up to a day, sent together from your browser, so while it is in transit and being counted it
  is a short list of shops one browser reported. The service adds each report into its running
  totals immediately and keeps nothing that links the reports in a batch to each other or to you.
- **The server stores counts, not reports.** Incoming reports are added into running totals
  keyed by shop, technique and day. No individual report is kept, and there is no column that
  could hold who sent it.
- **The service does not record who sent anything.** It reads nothing from a request except
  the report itself, never stores your IP address, and has per-request logging switched off
  in its deployed configuration. Like any website, the request still passes through the
  hosting provider's network on its way in; nothing about you is kept once the report has
  been counted.
- **Switching the setting off deletes the queue immediately.** Not at the next send — data
  gathered under a permission you have withdrawn is not held pending a change of mind.

You can see the exact reports that would be sent, verbatim, in **Settings → Help measure these
techniques → Show me exactly what would be sent**. Asking you to consent to a sentence about
your data is not the same as showing you the data.

**What the collected data is used for.** Research into persuasion techniques in online shopping:
how common they are, which shops use them, where in the checkout they appear, how often page
views that show each one are followed by an add to cart, and how all of that changes over time. Findings
may be published. Anything published is aggregated so that no single browsing session can be
picked out: a shop and technique are only included once enough independent batches have
reported them. The data is not sold, licensed, or used for advertising.

## Third parties

No analytics providers, no error reporting services, no advertising networks, no data brokers.
Nothing is sold, shared, or licensed.

If you switch sharing on, reports are received and stored on Cloudflare (Workers and D1), which
hosts the counting service. Cloudflare processes that traffic as a hosting provider; it is not
given the data for any purpose of its own.

## Children

The extension is not directed at children and collects no personal information from anyone.

## Changes

Material changes will be reflected here with an updated date, and in the extension's listing.

## Where this is published

The authoritative copy is served at
<https://viditchhajed.github.io/pensa-docs/privacy.html>.

Pensa was previously published as **Vero**. The policy formerly served at
`viditchhajed.github.io/vero-docs/` redirects here.

## Contact

Open an issue on the project repository.
