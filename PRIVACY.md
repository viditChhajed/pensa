# Privacy Policy — Vero

**Last updated: 2026-09-16**

## The short version

This extension sends nothing anywhere. It has no analytics, no account, and makes no network
requests of any kind. Everything it notices about a page is processed on your device and
stays on your device.

There is no server behind the build you install: the telemetry endpoint is a build-time
constant and it is empty, which is what the "zero outbound requests" test asserts against the
compiled bundles. The public repository does contain a `server/` directory — a sink that
would accept anonymous, k-anonymised counts if telemetry were ever switched on and an
endpoint compiled in. Nothing is deployed there, and no shipped build can reach it. It is in
the open so the shape of what *would* be sent can be read rather than trusted.

You can verify this rather than take our word for it: open DevTools, go to the Network tab,
and browse with the extension enabled. There will be no requests from it.

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
- **It still sends nothing anywhere.** Broad read access and zero network access are separate
  questions, and the second answer has not changed. That is asserted against the compiled
  bundles by an automated test, not merely stated here.
- **It records nothing about a page where it found nothing.** Access to read a page is not a
  record of having read it.

You can turn Vero off for any individual site, or entirely, from its Settings page. You can
also remove the permission wholesale by uninstalling, and Chrome lets you restrict any
extension's site access from its own extension settings, independently of anything Vero says.

## Optional telemetry

There is a setting for anonymous, aggregate telemetry. **It is off by default and there is no
pre-checked box.** While it is off, nothing is transmitted and nothing is even recorded for
transmission — the queue is not filled and then withheld, because a queue that accumulates
while you have said no is one that would empty the moment you said yes.

If you switch it on, each count carries exactly seven fields and no others:

| | |
|---|---|
| pattern type | e.g. `scarcity.stock` |
| detector id | which rule matched |
| confidence quartile | 1–4, never the score |
| funnel stage | browse / product / cart / checkout / payment |
| site **category** | e.g. `ota_travel` — never the site |
| rule pack version | |
| hour | epoch hours, never a timestamp |

A count says *"someone saw a countdown, on a travel site, in this hour."* Absent by
construction: the web address, the page path, the session id, any page text, any price, any
precise time, anything identifying you. The record type is declared `.strict()`, so an
accidentally added field throws rather than being sent.

Four further limits, each enforced in code rather than promised here:

- **Counts are sent on a six-hour timer, never when something is found.** A request timed to
  a detection would reveal when you were shopping even though the payload cannot say where.
- **A batch is held until at least 20 reports share its shape.** A count only you could have
  produced is not anonymous however few fields it carries.
- **Nothing is sent for a site outside the bundled list.** The category tag is what makes a
  count anonymous, and an unlisted site has no category.
- **Switching the setting off deletes the queue immediately.** Not at the next send — data
  gathered under a permission you have withdrawn is not held pending a change of mind.

You can see the exact rows that would be sent, verbatim, in **Settings → Anonymous statistics
→ Show me exactly what would be sent**. Asking you to consent to a sentence about your data
is not the same as showing you the data.

## Third parties

There are none. No analytics providers, no error reporting services, no advertising networks,
no data brokers. Nothing is sold, shared, or licensed, because nothing is collected.

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
