# Privacy Policy — Vero

**Last updated: 2026-09-16**

## The short version

By default this extension sends nothing anywhere. It has no analytics and no account, and with
the default settings it makes no network requests of any kind. Everything it notices about a
page is processed on your device and stays on your device.

The one exception is a setting you have to switch on yourself: sharing which shops use which
techniques, described in full below. It is off unless you turn it on.

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

Locally on your device, in your browser's extension storage:

- Which sites you have turned it off for, if any.
- A record of patterns it noticed: the pattern type, a confidence number, how long the
  element was on screen, the funnel stage, the site's origin (for example
  `https://www.example.com`), and a redacted path shape (for example `/products/:slug`).
- A one-way hash of matched text, plus a short text excerpt used only to show you what was
  matched.
- Settings you choose.

Default retention is 30 days. You can delete everything at any time from the extension's
Settings page ("Delete all my data").

## What it never stores or transmits

- Full URLs or query strings.
- Anything you type, including search terms, addresses, and payment details.
- Cart contents, order totals, or prices you paid.
- Names, email addresses, phone numbers, or any account identifier.
- Browsing history. It keeps no list of pages you visited, and no record at all of a page where it found nothing.

## Site permissions

**Vero asks for access to all https websites at install time, and Chrome will tell you so in
those words.** You should read that warning as accurate: the permission is broad, and it is
granted the moment you install rather than site by site.

This is a deliberate change from how Vero previously worked, and it is worth being plain
about the trade. The earlier design asked for one site at a time, which made the permission
narrow and the tool nearly useless — a shopper had to already suspect a page before they
could ask Vero to look at it, which is precisely backwards for a tool whose whole purpose is
to notice what you did not. Persuasion techniques are not confined to a list of large
retailers; they turn up on small independent shops, regional sites, and storefronts that did
not exist when any list was written. A fixed list is always wrong, and it is wrong in the
direction that leaves people unprotected.

So the permission is broad. What constrains it is not the permission; it is what the code
does with it, and that is public and testable:

- **Vero never runs on banking, health, government, or webmail sites.** This is enforced in
  two independent layers: those hosts are excluded from the content script's match patterns,
  so Chrome does not inject Vero there at all; and the script additionally refuses to run on
  any denied host before it reads anything. The list is in `src/shared/urlScore.ts` and the
  build fails if it is empty.
- **Only `https` sites.** Plain `http` pages are outside the requested permission entirely.
- **It sends nothing anywhere unless you switch sharing on.** Broad read access and network
  access are separate questions. With the default settings there are zero outbound requests,
  asserted against the compiled bundles by an automated test, not merely stated here.
- **It records nothing about a page where it found nothing.** Access to read a page is not a
  record of having read it.

You can turn Vero off for any individual site, or entirely, from its Settings page. You can
also remove the permission wholesale by uninstalling, and Chrome lets you restrict any
extension's site access from its own extension settings, independently of anything Vero says.

## Optional: helping measure these techniques

There is a setting to share which shops use which techniques. **It is off by default and there
is no pre-checked box.** While it is off, nothing is transmitted and nothing is even recorded
for transmission — the queue is not filled and then withheld, because a queue that accumulates
while you have said no is one that would empty the moment you said yes.

**If you switch it on, it names the shop.** That is its purpose: to build a picture, shop by
shop, of how often these techniques are used. A report says *"someone saw a countdown on
shein.com today."* It is sent to a server run by this project and stored there.

Each report carries exactly eight fields and no others:

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

Never included: the page, the product, the search, the path or the full web address; any page
text or prices; your account, name, email, or any identifier for you or your browser; and any
time more precise than the day. The record type is declared `.strict()` in the extension and
the server independently rejects any report with a field outside that list, so an accidentally
added field is refused at both ends rather than stored.

The limits, each enforced in code rather than promised here:

- **Only shops can be reported.** Vero reads each page and decides whether it is selling
  something before it does anything else. A detection — and therefore a report — can only
  exist on a page that passed that check. A site you visit that is not a shop is never
  reported, whatever it is.
- **The day, not the time.** A shop plus an exact time is far easier to tie to one person's
  browsing than a shop plus a date, and measuring how common a technique is needs no more
  than the date.
- **Sent on a timer, never at the moment something is found.** Reports go out in batches every
  six hours, so the timing of a request does not reveal when you were shopping.
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

**What the collected data is used for.** Measuring how common persuasion techniques are, which
shops use them, where in the checkout they appear, and how that changes over time. Findings
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
<https://viditchhajed.github.io/vero-docs/privacy.html>.

The previous address lived under the project's old name and no longer resolves. If you
followed a `persuasion-patterns-docs` link here, the URL above is the current one.

## Contact

Open an issue on the project repository.
