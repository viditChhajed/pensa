# Chrome Web Store listing — draft

Everything here is copy-ready except the four assets marked **NEEDS YOU**. Nothing in this
document makes a precision or effectiveness claim, because there is no data to support one
yet ([EVAL.md](EVAL.md)) — and a claim in a store listing is exactly the kind of thing a
reviewer checks.

---

## Item name (45 char limit)

```
Persuasion Patterns
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
Persuasion Patterns notices the techniques a shopping page is using — countdown timers,
"only 3 left" messages, crossed-out reference prices, pre-ticked add-ons, fees that appear
only at checkout — and, when you add something to your cart, asks you one question about
what was actually on your screen.

It does not tell you what to buy. It does not block anything, hide anything, or change any
page. It asks.

WHAT IT NOTICES

• Reference prices — a higher crossed-out price next to the real one
• Charm pricing — prices that stop just short of a round number
• Limited-stock messages
• Countdown timers
• Live activity notices — "23 people are viewing this"
• Pre-selected options — warranties, add-ons, marketing opt-ins
• Loaded decline wording — "No thanks, I don't want to save money"
• Spend thresholds — "You're $12 away from free shipping"
• Instalment framing — "4 interest-free payments of $24.99"
• Fees added later — charges that were not in the first price you saw
• Unrequested cart items

HOW IT TALKS TO YOU

Every prompt is a question, never an accusation. It reports what the page displayed and asks
what you think — it never claims a message is false, and it makes no claim about any
retailer's intent. A limited-stock message may be perfectly accurate; the point is whether
knowing that changes your decision.

The card is small, appears in a corner, disappears by itself after 20 seconds, and will not
show at all if there is nowhere on the page it can sit without covering something you might
want to click.

PRIVACY

There is no server. There are no analytics. There is no account. The extension makes no
network requests at all, and you can check that yourself: open DevTools, go to the Network
tab, and browse.

Everything it notices stays on your device and is deleted after 30 days. You can erase it
all at any time from Settings.

It asks for no site access when you install it. You grant one site at a time, from the
toolbar, and you can revoke any of them whenever you like. It will never offer to run on
banking, health, government or webmail sites.

CONTROLS

Choose how often you are interrupted: every checkout, once per site, or never — read the
summary on your own schedule instead. The setting is there from day one, because being
interrupted repeatedly is the fastest way for a tool like this to become annoying.

OPEN SOURCE

The full source, including the list of sites and the exact wording of every prompt, is
public.
```

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

**`declarativeContent`**
```
Highlights the toolbar icon on URLs that look like shopping pages. This is evaluated by the
browser from the URL alone — it grants no page access and reads no page content.
```

**`optional_host_permissions` (~150 shopping origins)**
```
None of these are granted at install. Each is requested individually, from a button in the
popup, only when you choose to enable that site, and can be revoked at any time from
Settings.
```

**Single purpose statement**
```
Identify persuasion techniques displayed on shopping pages and present the user with a
question about them.
```

**Data usage disclosures** — tick nothing. The extension collects no user data and transmits
none. Certify: does not sell data, does not use it for unrelated purposes, does not use it
for creditworthiness.

---

## Privacy policy URL — **NEEDS A DECISION FROM YOU**

Required by the store; the listing cannot be submitted without a reachable URL.
[PRIVACY.md](PRIVACY.md) is written and current. Options:

1. **GitHub Pages** — make the repo public (or a small docs-only repo) and serve
   `PRIVACY.md`. Free, ~10 minutes, gives a stable
   `https://viditchhajed.github.io/persuasion-patterns/privacy` URL. **Recommended.**
2. **A gist** — fastest, but a gist URL looks improvised to a reviewer.
3. **Your own domain**, if you have one.

I cannot make the repo public or create the Pages site for you — publishing is your call, and
the repo is currently private on purpose. Tell me which you want and I will prepare the file
and the exact steps.

---

## Assets

### I can generate

- **Icons** (16 / 32 / 48 / 128 px). Currently **missing entirely** — the manifest declares
  no icons, so Chrome is using a default placeholder. I can produce a simple mark (a
  magnifier over a price tag, or a question mark in a tag outline) as SVG and export the PNG
  sizes. Say the word and I will.
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
4. Settings → interruption frequency, showing the user is in control.

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

- [ ] `npm run build` clean; `npm test` and `npm run test:e2e` green
- [ ] `host_permissions` empty in the built manifest (CI-enforced, but look anyway)
- [ ] Icons present at all four sizes
- [ ] Privacy policy URL live and reachable
- [ ] **[EVAL.md](EVAL.md) filled in, and any detector over ~4 false positives raised or disabled**
- [ ] Screenshots captured
- [ ] Version bumped in `wxt.config.ts`
- [ ] `npm run zip`

The EVAL.md line is the real gate. Everything else is paperwork; that one is the difference
between a tool that helps and one that interrupts people with wrong claims.
