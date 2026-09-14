# Privacy Policy — Vero

**Last updated: 2026-09-06**

## The short version

This extension sends nothing anywhere. It has no server, no analytics, no account, and no
network requests of any kind. Everything it notices about a page is processed on your device
and stays on your device.

You can verify this rather than take our word for it: open DevTools, go to the Network tab,
and browse with the extension enabled. There will be no requests from it.

## What the extension does

On sites you have explicitly enabled, it reads the page to notice persuasion techniques —
countdown timers, limited-stock messages, crossed-out reference prices, preselected
checkboxes, and similar. When you add something to a cart or begin checkout, it may show a
small card with a question about what it noticed.

## What it stores, and where

Locally on your device, in your browser's extension storage:

- Which sites you have enabled it on.
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
- Browsing history on sites you have not enabled.

## Site permissions

The extension requests no site access at install time. Access is granted one site at a time,
by you, from the toolbar popup. You can revoke a site at any time from Settings or from
Chrome's extension settings. On sites you have not enabled, the extension cannot read
anything at all — this is enforced by the browser, not by our code.

The extension deliberately never offers to run on banking, health, government, webmail, or
similar sites, regardless of what those pages contain.

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
<https://viditchhajed.github.io/persuasion-patterns-docs/privacy.html>.

That URL predates the product being renamed to Vero. It is live and correct; renaming the
docs repo would change it, which is a decision about a published address rather than a
rename, so it is left alone deliberately.

## Contact

Open an issue on the project repository.
