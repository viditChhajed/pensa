# Privacy Policy — Persuasion Patterns

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
pre-checked box.** As of this version it is not wired to any server, so nothing is transmitted
even if enabled. Should that change, this policy will be updated first, and the data would be
limited to: pattern type, a confidence quartile, funnel stage, a site *category* (not the
site), and the hour. Never URLs, text, prices, or identifiers.

## Third parties

There are none. No analytics providers, no error reporting services, no advertising networks,
no data brokers. Nothing is sold, shared, or licensed, because nothing is collected.

## Children

The extension is not directed at children and collects no personal information from anyone.

## Changes

Material changes will be reflected here with an updated date, and in the extension's listing.

## Contact

Open an issue on the project repository.
