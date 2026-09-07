# Manual verification checklist

Everything machine-verifiable now runs in `npm run test:e2e` (real Chromium, real extension).
**One link in the chain cannot be automated** and is listed first.

## 1. The permission gesture — REQUIRES A HUMAN

`chrome.permissions.request()` raises a **native OS dialog**. It is not in the page DOM, so
no browser automation can accept it. Calling it from a service worker fails outright for want
of a user gesture — which is itself a real-browser confirmation of the plan's §1.4 finding.

```bash
npm run build
```

1. Load `.output/chrome-mv3` unpacked at `chrome://extensions` (Developer mode on).
2. Visit any allowlisted shopping site (e.g. `https://www.etsy.com`).
3. Click the toolbar icon → popup opens.
4. Click **Enable on this site**.

**PASS:** Chrome's permission prompt appears immediately.
**FAIL:** No prompt. An `await` crept in ahead of `permissions.request()` and ate the
gesture. The popup resolves the origin on open precisely so the click handler can be
synchronous — check `src/entrypoints/popup/main.ts`.

5. Grant, then reload the page. Open the service worker console from `chrome://extensions`.

**PASS:** no `[patterns] content script registration failed`, and browsing the site produces
a `ledger:<origin>` key under Application → Storage → Extension storage → Session.
**FAIL (silent):** registration succeeded but nothing injected. Registration and injection
are different facts — see plan §1.3.

## 2. Icon state — automated only for the rules, not the pixels

`declarativeContent` rule installation is asserted in e2e; the rendered greyscale is not.

- On `https://www.wikipedia.org` the icon should be **grey**.
- On `https://www.etsy.com` it should be **colour**.
- On `https://www.chase.com` it should be **grey and never offer enablement** (denylist).

## 3. Real-retailer spot-check (plan §10) — NOT YET RUN

30–40 pages across ≥6 retailers, hand-tallying each detector's firings as correct or
incorrect. Any detector with more than ~4 false positives gets its threshold raised or is
disabled by default. Record the tally in `EVAL.md`.

Until this runs, **no precision claim may be made about this extension.** Thresholds are
hand-set guesses, marked `hand_set` in the schema so they cannot be mistaken for calibrated
values.

## 4. Zero-egress confirmation

With telemetry declined, browse a full session with DevTools → Network open, filtered to the
extension. Expect **zero** outbound requests. This is the load-bearing claim in PRIVACY.md
and it should be verified by eye, not just by absence of fetch calls in source.

---

## What IS automated

`npm run test:e2e` — real Chromium, real extension, 13 tests:

- service worker boots; manifest **as Chrome parsed it** has empty `host_permissions` and no
  `content_scripts`
- extension holds no host permissions at install, and registers no content script while
  ungranted
- popup and options pages render every control; telemetry checkbox is unticked
- **registration AND injection** proven separately (injection via a worker-visible side
  effect, since content scripts run in an isolated world the page cannot see)
- content script throws nothing into the host page
- overlay survives 3 hostile CSS regimes, including one that actively tries to hide it by id
  and id-prefix
- overlay never wins the hit test over a checkout button
- detector work produces no long task over 200 ms

`npm run build` fails the build on a reintroduced `host_permission`, a manifest content
script, or any broad host pattern — verified by deliberately reintroducing each.
