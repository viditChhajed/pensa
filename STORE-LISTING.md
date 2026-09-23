# Chrome Web Store listing, draft

Everything here is copy-ready except the four assets marked **NEEDS YOU**. Nothing in this
document makes a precision or effectiveness claim, because there is no data to support one
yet ([EVAL.md](EVAL.md)), and a claim in a store listing is exactly the kind of thing a
reviewer checks.

---

## Item name (45 char limit)

```
Pensa
```

## Short description (132 char limit)

```
Notices persuasion techniques on shopping pages and asks a question about them. Runs on your device. Nothing is sent anywhere.
```

*(124 characters.)*

## Category

`Shopping`, with `Productivity` as the fallback if review pushes back.

## Language

English (United States).

---

## Detailed description

**Paste from [store/description.txt](store/description.txt)**, unwrapped, current, and the
version submitted. The block below is the original wrapped draft, kept for history; the
store renders line breaks literally, so do not paste it.

```
Pensa notices the techniques a shopping page is using, countdown timers,
"only 3 left" messages, crossed-out reference prices, pre-ticked add-ons, fees that appear
only at checkout, and, when you add something to your cart, asks you one question about
what was actually on your screen.

It does not tell you what to buy. It does not block anything, hide anything, or change any
page. It asks.

WHAT IT NOTICES

On the page in front of you:

• Reference prices, a higher crossed-out price next to the real one
• Charm pricing, prices that stop just short of a round number
• Limited-stock messages
• Countdown timers
• Live activity notices, "23 people are viewing this"
• Preselected options, warranties, add-ons, marketing opt-ins
• Loaded decline wording, "No thanks, I don't want to save money"
• Spend thresholds, "You're $12 away from free shipping"
• Unequal button emphasis, one choice made far louder than the other
• Decoy options, a third option that exists to make a second one look better
• Repeated interruptions
• Savings framing, the same discount shown as whichever number looks bigger
• Exit-intent offers, something that appears as you move to leave

By comparing one page to the next:

• Fees added later, charges that were not in the first price you saw
• Unrequested cart items

By comparing today to what the same site showed you before:

• Timers that reset on each visit
• Stock counts that go up as well as down
• "Was" prices that have never been the actual price
• Viewer counts that repeat or never vary

The last four say nothing on a first visit, by construction, they are claims about change
over time, and there is nothing to compare against until you have seen the same item twice.

HOW IT TALKS TO YOU

Every prompt is a question, never an accusation. It reports what the page displayed and asks
what you think, it never claims a message is false, and it makes no claim about any
retailer's intent. A limited-stock message may be perfectly accurate; the point is whether
knowing that changes your decision.

The card is small, appears in a corner, and stays until you close it, it does not time out
while you are reading it. It is never placed over a form field, a submit button, or anything
on the purchase path; it may sit over an ordinary link, which one click uncovers.

PRIVACY AND PERMISSIONS

Chrome will tell you Pensa can read the websites you visit, and that is accurate: it needs to,
because these techniques turn up on small and new shops as often as on big ones, and no list
of sites would cover them. What it does with that access is narrow:

• It reads a page and decides whether it is a shop first. On anything else, email, news,
  documents, chat, it stops, records nothing, and stays out of the way.
• It never runs on banking, health, government or webmail sites.
• There is no account, and no advertising or analytics company is involved at any point.
• Out of the box it makes no network requests at all. You can check: open DevTools, go to
  the Network tab, and browse.

Everything it notices stays on your device. Detections are deleted after 30 days; the
product history that lets it spot a countdown that resets or a "was" price that is never
charged is kept up to 90 days. You can export or erase all of it at any time from Settings.

OPTIONAL: HELP MEASURE THESE TECHNIQUES

One setting, off by default and not pre-ticked, shares which shops use which techniques so
their prevalence can be measured. It does name the shop: a report says "someone saw a
countdown on shein.com today." It never sends the page, the product, your searches, page
text, prices, your account, anything that identifies you, or any time more precise than the
day. Reports go out in batches, not at the moment something is found, and you can read the
exact reports waiting to be sent before any of them are. Turning it off deletes anything not
yet sent.

CONTROLS

Choose how often you are interrupted: every checkout, once per site, or never, read the
summary on your own schedule instead. The setting is there from day one, because being
interrupted repeatedly is the fastest way for a tool like this to become annoying.

Every technique in the list above has its own switch. Turn off anything you find unhelpful, 
one you already watch for yourself is just noise. Switching one off stops it being recorded
at all, not merely stops it being shown.

OPEN SOURCE

The full source, including the list of sites and the exact wording of every prompt, is
public.
```

> **ORDERING DEPENDENCY, the repo must be public BEFORE this listing is submitted.**
>
> `viditChhajed/pensa` is private today, deliberately: the decision is to stay
> private while the detectors are still being refined, and to flip public immediately before
> launch. That is a sound order, refine in private, ship in public, but it makes the
> paragraph above **false until the flip happens**, in the one direction a reviewer can check
> in ten seconds.
>
> So this is not an open question, it is a sequencing item, and it lives in the pre-submission
> checklist below. Add the repo URL to the paragraph when you flip it; an unverifiable claim
> of openness is weaker than a link.
>
> Before flipping: the history is public forever afterwards, and EVAL.md records real browsing
> sessions. Audit the history first.

---

## Permission justifications

Copy each into the corresponding field. These are the answers a reviewer is looking for.

**`storage`**
```
Stores the user's settings (which techniques to watch for, how often to be interrupted, how
long to keep detections), a local log of what was noticed so the extension can show a summary
and let the user export or delete it, and a short per-session record of checkout stages and
add-on choices. Stored on the device; detections are deleted after 30 days by default.
```

**`activeTab`**
```
Lets the popup read the address of the tab the user is looking at, so it can say whether
Pensa is running on that page, is idle because the page is not a shop, or never runs there
(banking, health, government and webmail sites). Used only while the popup is open.
```

**`alarms`**
```
Runs scheduled maintenance: every 12 hours it deletes locally stored detections older than
the user's retention period and product history older than 90 days. Only if the user has
switched on sharing, it also sends reports in batches every six hours rather than at the
moment something is found, so the timing of a report reveals nothing about when the user was
shopping. It grants no access to pages or data.
```

*(The earlier draft said "two scheduled jobs" and omitted the 90-day product-history
eviction that the housekeeping alarm also runs.)*

**Remote code:** No. The shipped bundle was scanned for `eval`, `new Function`,
`importScripts`, remote `<script src>` and URL `import()`, none present.

**Host permission: `https://*/*`**

> Chrome shows "Read and change all your data on all websites" for this. The justification
> has to explain why a fixed list will not do, and has to describe the real limits, reviewers
> look hardest at broad host permissions, and a vague answer here is the likeliest rejection.

```
Pensa detects persuasion techniques, countdown timers, limited-stock claims, crossed-out
reference prices, preselected add-ons, fees added at checkout, on the shopping pages a user
visits, and asks them a question about what was on screen before they buy.

It needs to read pages on sites that cannot be listed in advance. These techniques appear on
small independent stores, regional retailers and new storefronts as much as on large
retailers, and a fixed list would leave users unprotected exactly where a list is least
likely to reach.

What limits it:
- It reads each page and decides whether it is a shop before doing anything else. On a page
  that is not selling something it stops, records nothing, and checks again only rarely.
- It never runs on banking, health, government or webmail sites. Those hosts are excluded
  from the content script's match patterns, so Chrome does not inject it there, and the
  script also refuses to run on them at startup.
- https only.
- By default it makes no network requests at all. The only data that can leave the device is
  an optional, off-by-default report described in the privacy practices section.
```

**Single purpose statement**
```
Identify persuasion techniques displayed on shopping pages and present the user with a
question about them.
```

**Data usage disclosures**, depends on whether a telemetry endpoint is deployed. Read this
before ticking anything; a listing that says "collects nothing" while the extension posts
counts is the kind of mismatch that fails review.

*If `TELEMETRY_ENDPOINT` in `src/shared/constants.ts` is empty* (the shipped default): tick
nothing. Nothing is transmitted, and four e2e tests assert it.

*If an endpoint is configured* (the build you upload once the sink is deployed): tick
**Web history** and **User activity**. The shop's domain is browsing activity; whether Add to
Cart was clicked is user activity (a click). Use this wording (fits the 1,000-character field):

```
Optional and off by default. Pensa asks once, on its first card, with two equal answers; closing the card counts as no. When on, it reports which persuasion technique appeared on which shop (main domain only, e.g. shein.com), at which checkout stage, and on which day. On product and listing pages it also reports whether the Add to Cart button was clicked, alongside the techniques on screen beforehand, as separate counts. It never sends the page address, product, search, page text, prices, account details, any identifier for the user, or any time more precise than the day. Only pages judged to be shops are reported. Reports are batched on a six-hour timer and stored only as aggregate counts. Users can view the exact reports before any are sent, and switching sharing off deletes anything unsent. The data is used for research on how common these techniques are and how often people add items after seeing them.
```

Chrome Web Store user-data policy also requires the in-product consent to be prominent and
affirmative before collection starts. Settings → "Help measure these techniques" is that
consent: unticked by default, and it names the shop-level collection in plain words rather
than calling it anonymous statistics. The install page (`welcome.html`, opened once by
`chrome.runtime.onInstalled`) is where that disclosure is made, see `05-welcome.png`. The one-time question on the first card is the prominent
disclosure: it states who builds Pensa, what is shared (including the add-to-cart outcome), and
offers two equal answers with nothing preselected. See `CONSENT_COPY` in src/content/ui/card.ts.

Certify in both cases: does not sell data, does not use it for unrelated purposes, does not
use it for creditworthiness.

---

## Privacy policy URL, **DONE**

```
https://viditchhajed.github.io/pensa-docs/privacy.html
```

Live and returning 200, served from a separate docs repo. Paste it into the listing's
Privacy policy field. The page is generated verbatim from PRIVACY.md, so the published
policy and the committed one cannot drift.

Keep it in step with [PRIVACY.md](PRIVACY.md): that file is the source and the page is a
copy, so a change to one that does not reach the other means the published policy and the
committed policy disagree. Re-check the page after any edit to PRIVACY.md.

---

## Assets

### I can generate

- **Icons** (16 / 32 / 48 / 128 px). **Done**, present in `public/icon/`, declared in the
  manifest, and in the build output. Replace them if you want a different mark; nothing is
  blocked on it.
- **Promotional tile text**, if you use the optional 440×280 tile.

### NEEDS YOU

| Asset | Spec | Why I cannot do it |
|---|---|---|
| **Screenshots** (1–5) | 1280×800 or 640×400 PNG | Must show the extension running on a real shopping page. That needs the manual grant flow, which raises a native dialog no automation can accept. |
| **Demo video** (optional) | YouTube link | Same reason. Optional, but it measurably helps review. |
| **Developer account** | $5 one-time | Payment and identity verification, I cannot and should not do this. |
| **Publisher identity** | Real name or verified org | Store requirement. |

**Suggested screenshots**, in order of usefulness to a reviewer (`05-welcome.png` is generated
by `tests/e2e/welcome.spec.ts`, the rest by `npm run screenshots`):

0. The install page, showing how sharing consent is asked: what is shared, what is not, and two
   equally weighted answers with nothing preselected. Worth including, it is the prominent
   disclosure the user-data policy asks for, in one image.

1. The card on a real product page, showing one question.
2. The popup on a shopping page, saying Pensa is running there and showing today's summary.
3. Settings → *What was noticed today*, showing the Noticed / Shown split.
4. Settings → *What to watch for*, showing a switch per technique and the frequency control.
   This is the screenshot that answers "can I turn it down?", which is the first thing a
   sceptical installer wants to know.

One thing to get right in screenshot 1: the card only appears at add-to-cart or
checkout-intent, never passively on a product page. So capture it just after clicking Add to
Cart, or on arrival at checkout.

---

## Submit as **Unlisted** first, recommendation

Fully reviewed, installable by link, not publicly discoverable. It lets you validate that
review passes and that precision holds up on real traffic before a public listing exists to
be judged. Flipping to Public later is one setting.

---

## Pre-submission checklist

- [x] `npm run build` clean; `npm test` and `npm run test:e2e` green, 608 unit + eval, 48 e2e
- [x] `host_permissions` empty in the built manifest (CI-enforced, checked: `[]`)
- [x] Icons present at all four sizes
- [x] Privacy policy URL live and reachable
- [x] **Spot-check re-run against THIS build.** It was the real gate and it earned that
      billing. The warning that stood here, that the detectors had been substantially
      rewritten since the last check, that every new rule is a new chance to fire on
      something it should not, and that corpus precision could not settle it because a
      detector agreeing with a model is not the same as a detector being right, turned out
      to be exactly correct. `npm run spot:check` over 64 pages on 22 live sites found **27
      wrong claims out of 170**, one detector wrong in every single firing, and a bug in the
      shared money parser underneath it. Two further runs found 2 more, and a line-by-line code
      audit then found a dozen defects the live runs could not see, including add-on
      attribution that had never worked and a 400-character text cap that made Pensa silent on
      every travel and ticketing site. All are fixed and regression-tested; 157 claims stand on
      the repaired build. Tally and provenance in [EVAL.md](EVAL.md).
- [x] Screenshots captured, `npm run screenshots`, four 1280×800 PNGs in `store/screenshots/`,
      taken from the running build against a live retailer
- [x] Pre-publication audit of the full history, 89 commits, 496 blobs. No secrets, no
      personal data, no fixture ever committed unscrubbed, `corpus/` never tracked. The worry
      recorded here previously ("EVAL.md holds real browsing sessions") was unfounded: that
      file records short labels, never URLs with query strings. No history rewrite needed.
- [x] LICENSE added (ISC, matching `package.json`), a public repo without one grants nobody
      any rights
- [x] Version bumped in `wxt.config.ts`, 1.1.0 (renamed from Vero; 1.0.0 was published as Vero)
- [x] `npm run zip`, `.output/pensa-1.1.0-chrome.zip`

### The zip to upload

The prevalence sink is **deployed** at `https://pensa-counts.viditchhajed.workers.dev/counts`
and verified end to end: the shipped build posted a real batch, it landed in D1, and the
research views read it back. So the upload is the build WITH the endpoint:

```bash
TELEMETRY_ENDPOINT=https://pensa-counts.viditchhajed.workers.dev/counts npm run zip
```

A zip from a plain `npm run build` has the send path compiled out entirely and will never
contribute to the dataset. Because the uploaded build transmits (when the user opts in), the
Data usage section must use the "endpoint is configured" wording above and tick **Web history**.

### Still yours to do

- [ ] **Chrome Web Store developer account**, $5 one-time, with identity verification
- [ ] **Flip the repo to public**, the listing says the source is public. The audit above
      says it is safe to flip; nothing else blocks it
- [ ] **Decide listing visibility.** Unlisted first is still the recommendation above: fully
      reviewed, installable by link, not publicly discoverable, one setting to flip later

**What is NOT done, and should not be claimed:** the §10 *human* pass. A person browsing
30–40 pages and judging each card is the only thing that catches a claim that was true and
useless, and the automated audit cannot stand in for it, it reads the detector's log, never
the card. [MANUAL-VERIFICATION.md](MANUAL-VERIFICATION.md) §3 has the protocol.
