# Chrome Web Store listing — draft

Everything here is copy-ready except the four assets marked **NEEDS YOU**. Nothing in this
document makes a precision or effectiveness claim, because there is no data to support one
yet ([EVAL.md](EVAL.md)) — and a claim in a store listing is exactly the kind of thing a
reviewer checks.

---

## Item name (45 char limit)

```
Vero
```

## Short description (132 char limit)

```
Notices persuasion techniques on shopping pages and asks a question about them. Runs on your device. Nothing is sent anywhere.
```

*(124 characters.)*

## Category

`Shopping` — with `Productivity` as the fallback if review pushes back.

## Language

English (United States).

---

## Detailed description

```
Vero notices the techniques a shopping page is using — countdown timers,
"only 3 left" messages, crossed-out reference prices, pre-ticked add-ons, fees that appear
only at checkout — and, when you add something to your cart, asks you one question about
what was actually on your screen.

It does not tell you what to buy. It does not block anything, hide anything, or change any
page. It asks.

WHAT IT NOTICES

On the page in front of you:

• Reference prices — a higher crossed-out price next to the real one
• Charm pricing — prices that stop just short of a round number
• Limited-stock messages
• Countdown timers
• Live activity notices — "23 people are viewing this"
• Preselected options — warranties, add-ons, marketing opt-ins
• Loaded decline wording — "No thanks, I don't want to save money"
• Spend thresholds — "You're $12 away from free shipping"
• Installment framing — "4 interest-free payments of $24.99"
• Unequal button emphasis — one choice made far louder than the other
• Decoy options — a third option that exists to make a second one look better
• Repeated interruptions
• Savings framing — the same discount shown as whichever number looks bigger
• Exit-intent offers — something that appears as you move to leave

By comparing one page to the next:

• Fees added later — charges that were not in the first price you saw
• Unrequested cart items

By comparing today to what the same site showed you before:

• Timers that reset on each visit
• Stock counts that go up as well as down
• "Was" prices that have never been the actual price
• Viewer counts that repeat or never vary

The last four say nothing on a first visit, by construction — they are claims about change
over time, and there is nothing to compare against until you have seen the same item twice.

HOW IT TALKS TO YOU

Every prompt is a question, never an accusation. It reports what the page displayed and asks
what you think — it never claims a message is false, and it makes no claim about any
retailer's intent. A limited-stock message may be perfectly accurate; the point is whether
knowing that changes your decision.

The card is small, appears in a corner, and stays until you close it — it does not time out
while you are reading it. It is never placed over a form field, a submit button, or anything
on the purchase path; it may sit over an ordinary link, which one click uncovers.

PRIVACY

There is no account, and no advertising or analytics company is involved at any point.

Out of the box the extension makes no network requests whatsoever, and you can check that
yourself: open DevTools, go to the Network tab, and browse.

There is one optional setting, off by default and not pre-ticked, that shares anonymous
counts of which techniques appear where. If you turn it on, a count says "someone saw a
countdown, on a travel site, in this hour" — no web address, no page content, no prices, no
identifiers, no precise time. Counts are held back until at least 20 other reports share the
same shape, because a count only you could have produced is not anonymous. You can read the
exact records waiting to be sent, before any of them are, in Settings.

Everything it notices stays on your device and is deleted after 30 days. You can erase it
all at any time from Settings, and that includes any anonymous counts still waiting to be
sent.

It asks for no site access when you install it. You grant one site at a time, from the
toolbar, and you can revoke any of them whenever you like. It will never offer to run on
banking, health, government or webmail sites.

CONTROLS

Choose how often you are interrupted: every checkout, once per site, or never — read the
summary on your own schedule instead. The setting is there from day one, because being
interrupted repeatedly is the fastest way for a tool like this to become annoying.

Every technique in the list above has its own switch. Turn off anything you find unhelpful —
one you already watch for yourself is just noise. Switching one off stops it being recorded
at all, not merely stops it being shown.

OPEN SOURCE

The full source, including the list of sites and the exact wording of every prompt, is
public.
```

> **ORDERING DEPENDENCY — the repo must be public BEFORE this listing is submitted.**
>
> `viditChhajed/vero` is private today, deliberately: the decision is to stay
> private while the detectors are still being refined, and to flip public immediately before
> launch. That is a sound order — refine in private, ship in public — but it makes the
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
Stores your per-site choices, your interruption-frequency setting, and a local log of what
was noticed, so the extension can show you a summary. All of it stays on the device and is
deleted after 30 days.
```

**`scripting`**
```
Registers the detection script at runtime, but only for sites you have explicitly enabled
from the toolbar. No content script is declared in the manifest, so the extension has no
page access at install time.
```

**`activeTab`**
```
Lets the popup read the current tab's address so it can offer to enable that specific site.
Used only while the popup is open.
```

**`alarms`**
```
Runs two scheduled jobs: deleting locally stored detections older than 30 days, and sending
the optional anonymous counts on a timer rather than at the moment something is found. This
permission shows no warning at install and grants no access to pages or data.
```

**`declarativeContent`**
```
Highlights the toolbar icon on URLs that look like shopping pages. This is evaluated by the
browser from the URL alone — it grants no page access and reads no page content.
```

**`optional_host_permissions` (~150 named shopping origins, plus `https://*/*`)**

> Read the manifest before submitting this one. It declares ~150 named origins AND the broad
> `https://*/*` pattern, and a justification that mentions only the named list will not match
> what the reviewer is looking at. The broad pattern is there because shopping happens on
> sites no list contains; nothing about it is granted at install.

```
Nothing here is granted at install — this is the optional list, not the required one, so the
extension has no site access when it is added and the install prompt asks for none.

Access is requested one site at a time, by clicking a button in the popup while you are on
that site, and Chrome shows its own prompt for that single site each time. Any site can be
revoked from Settings, and revoking it immediately unregisters the script.

The list includes https://*/* because a fixed list of shopping sites is always wrong: people
shop on small independent stores, regional retailers, and sites that did not exist when the
list was written, and a user who wants the extension on one of those should be able to grant
it. The extension never requests this pattern. It only ever requests the single site you are
looking at when you press the button.

The extension will not offer to run on banking, health, government or webmail sites. That
denylist is checked before anything else, and on those sites the button is not shown at all.
```

**Single purpose statement**
```
Identify persuasion techniques displayed on shopping pages and present the user with a
question about them.
```

**Data usage disclosures** — depends on whether a telemetry endpoint is deployed. Read this
before ticking anything; a listing that says "collects nothing" while the extension posts
counts is the kind of mismatch that fails review.

*If `TELEMETRY_ENDPOINT` in `src/shared/constants.ts` is empty* (the shipped default): tick
nothing. Nothing is transmitted, and four e2e tests assert it.

*If an endpoint is configured*: the extension collects an optional, off-by-default anonymous
count. Disclose it, and use this wording:

```
Optional and off by default. If a user turns it on, the extension sends a count of which
persuasion technique was seen, at which stage of a checkout, in which CATEGORY of shop, in
which hour. It sends no web address, no page content, no prices, no identifiers and no
precise time, and it sends nothing at all for sites outside the bundled list. Counts are
batched and withheld until at least 20 reports share the same shape. The user can view the
exact records awaiting transmission in the extension's settings before any are sent.
```

Certify in both cases: does not sell data, does not use it for unrelated purposes, does not
use it for creditworthiness.

---

## Privacy policy URL — **DONE**

```
https://viditchhajed.github.io/persuasion-patterns-docs/privacy.html
```

Live and returning 200, served from a separate docs repo so the extension repo can stay
private. Paste it into the listing's Privacy policy field.

> **The URL still says `persuasion-patterns-docs`.** That is a real address on GitHub Pages
> and renaming it is your call, not a find-and-replace: renaming the repo changes the URL and
> breaks the old one, which matters if it has been shared anywhere.
>
> Nothing is wrong with submitting as-is — a policy URL does not have to match the product
> name, and a live URL beats a tidy dead one. But it will look like a leftover to anyone who
> notices, so either rename the docs repo and update both files, or leave it deliberately.
> GitHub keeps a redirect from the old name, so renaming is safe if you do it.

Keep it in step with [PRIVACY.md](PRIVACY.md): that file is the source and the page is a
copy, so a change to one that does not reach the other means the published policy and the
committed policy disagree. Re-check the page after any edit to PRIVACY.md.

---

## Assets

### I can generate

- **Icons** (16 / 32 / 48 / 128 px). **Done** — present in `public/icon/`, declared in the
  manifest, and in the build output. Replace them if you want a different mark; nothing is
  blocked on it.
- **Promotional tile text**, if you use the optional 440×280 tile.

### NEEDS YOU

| Asset | Spec | Why I cannot do it |
|---|---|---|
| **Screenshots** (1–5) | 1280×800 or 640×400 PNG | Must show the extension running on a real shopping page. That needs the manual grant flow, which raises a native dialog no automation can accept. |
| **Demo video** (optional) | YouTube link | Same reason. Optional, but it measurably helps review. |
| **Developer account** | $5 one-time | Payment and identity verification — I cannot and should not do this. |
| **Publisher identity** | Real name or verified org | Store requirement. |

**Suggested screenshots**, in order of usefulness to a reviewer:

1. The card on a real product page, showing one question.
2. The popup with **Enable on this site**, showing the near-empty permission ask.
3. Settings → *What was noticed today*, showing the Noticed / Shown split.
4. Settings → *What to watch for*, showing a switch per technique and the frequency control.
   This is the screenshot that answers "can I turn it down?", which is the first thing a
   sceptical installer wants to know.

One thing to get right in screenshot 1: the card only appears at add-to-cart or
checkout-intent, never passively on a product page. So capture it just after clicking Add to
Cart, or on arrival at checkout.

---

## Submit as **Unlisted** first — recommendation

Fully reviewed, installable by link, not publicly discoverable. It lets you validate that
review passes and that precision holds up on real traffic before a public listing exists to
be judged. Flipping to Public later is one setting.

---

## Pre-submission checklist

- [x] `npm run build` clean; `npm test` and `npm run test:e2e` green — 549 unit + eval, 43 e2e
- [x] `host_permissions` empty in the built manifest (CI-enforced, checked: `[]`)
- [x] Icons present at all four sizes
- [x] Privacy policy URL live and reachable
- [x] **Spot-check re-run against THIS build.** It was the real gate and it earned that
      billing. The warning that stood here — that the detectors had been substantially
      rewritten since the last check, that every new rule is a new chance to fire on
      something it should not, and that corpus precision could not settle it because a
      detector agreeing with a model is not the same as a detector being right — turned out
      to be exactly correct. `npm run spot:check` over 64 pages on 22 live sites found **27
      wrong claims out of 170**, one detector wrong in every single firing, and a bug in the
      shared money parser underneath it. All fixed and regression-tested; 145 claims on the
      re-run. Tally and provenance in [EVAL.md](EVAL.md).
- [x] Screenshots captured — `npm run screenshots`, four 1280×800 PNGs in `store/screenshots/`,
      taken from the running build against a live retailer
- [x] Pre-publication audit of the full history — 89 commits, 496 blobs. No secrets, no
      personal data, no fixture ever committed unscrubbed, `corpus/` never tracked. The worry
      recorded here previously ("EVAL.md holds real browsing sessions") was unfounded: that
      file records short labels, never URLs with query strings. No history rewrite needed.
- [x] LICENSE added (ISC, matching `package.json`) — a public repo without one grants nobody
      any rights
- [x] Version bumped in `wxt.config.ts` — 1.0.0
- [x] `npm run zip` — `.output/vero-1.0.0-chrome.zip`

### Still yours to do

- [ ] **Chrome Web Store developer account** — $5 one-time, with identity verification
- [ ] **Flip the repo to public** — the listing says the source is public. The audit above
      says it is safe to flip; nothing else blocks it
- [ ] **Decide listing visibility.** Unlisted first is still the recommendation above: fully
      reviewed, installable by link, not publicly discoverable, one setting to flip later

**What is NOT done, and should not be claimed:** the §10 *human* pass. A person browsing
30–40 pages and judging each card is the only thing that catches a claim that was true and
useless, and the automated audit cannot stand in for it — it reads the detector's log, never
the card. [MANUAL-VERIFICATION.md](MANUAL-VERIFICATION.md) §3 has the protocol.
