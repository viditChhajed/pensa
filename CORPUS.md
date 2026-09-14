# Building the §18D training corpus

## Why this exists

Every recall miss recorded in [EVAL.md](EVAL.md) run 1 was a phrasing I invented that no real
site uses — *"only 3 left AT THIS PRICE"*, *"add $2.77 more TO CART FOR"*. The lexicons and
the fixtures came out of the same imagination, so the unit tests agreed with themselves and
the field did not.

That cannot be fixed by guessing harder. §18D replaces the fixed phrase lists with a model
trained on real sentences: it scores overlapping 3–5 character fragments, so it does not
depend on exact words and survives misspellings, emoji, missing spaces and British spelling.
`src/shared/classifier.ts` already has the featuriser, the training and the evaluation. The
only missing ingredient is labelled examples.

## The three commands

```bash
npm run corpus:collect    # gather real page text        (~40 min, unattended)
npm run label             # you label it                 (~1 hour, the only manual step)
npm run corpus:train      # fit and gate the models      (seconds)
```

## 1. Collect

Visits ~50 shops, follows product links two levels deep, scrolls each page so lazy-loaded
badges render, and runs **the shipped harvest** — esbuild-bundled from `src/content/harvest.ts`
at collect time, so the model trains on exactly the text distribution it will see in
production. A separate "good enough" extractor here would be a silent and very hard bug.

```bash
npm run corpus:collect                              # the default site list
npm run corpus:collect -- --sites shein.com,temu.com --pages 12
```

The site list is weighted toward travel, ticketing and fast fashion on purpose. The first
run used twenty tame retailers and produced **six** snippets matching any scarcity vocabulary
out of 1093 — REI does not run countdown timers, and a corpus drawn from shops that do not
use a technique cannot teach a model to recognise it. The tame shops stay in the list,
because a model trained only on shops that shout will call an ordinary product page a dark
pattern.

Text is scrubbed before it is written (email, phone, address, postcode, card-shaped digit
runs, JWTs, order numbers) and deduplicated across the whole corpus — retail markup repeats
one string dozens of times, and labelling the same sentence thirteen times is thirteen times
the work for one example's worth of signal.

Expect a third of travel sites to return ~1 snippet. They bot-block aggressively; that is
the crawl being refused, not the collector failing. It fails loudly if the harvest bundle
itself is broken, because "0 snippets from every site" and "every site blocked us" look
identical otherwise.

## 2. Label — automated, with one human check

```bash
npm run corpus:export     # stratified batches -> corpus/batches/
# labellers write corpus/auto/batch-N.jsonl
npm run corpus:ingest     # merge into corpus/labels.jsonl
```

Hand-labelling 500 items was the original plan and it was the wrong ask: most snippets are
obvious, and a person clicking "no" four hundred times is expensive attention spent where it
adds nothing. The automated pass reads **every message-shaped snippet** — 2,639 of them,
capped at 120 per site so eBay does not teach the model its house style — and asks which of
the six patterns each one is, if any.

Note this is NOT the tiered queue the interactive tool serves. Those tiers exist to spend a
person's attention well, and they inherit the loose regexes' blind spots — fatal here, since
the entire reason to widen the labelling is to find positives the lexicons never recruited.

### What automated labels are, and are not

**They are legitimate training data.** The text is real, from 36 real shops. Judging real
sentences is a different act from inventing them, and inventing them is what produced the
lexicon misses in the first place.

**They are not validation.** A classifier trained on them learns a compression of one
judgement. If that judgement is wrong in some systematic way, the model will be wrong the
same way and will agree with itself confidently. So:

- Nothing in [EVAL.md](EVAL.md) may cite them as a precision result.
- `npm run corpus:train` reports, per pattern, **how many positives the existing lexicon would
  have missed**. If that number is near zero the model has learned the regexes in a more
  expensive form, and the honest response is not to ship it.
- Every row carries `source: "auto"`. Hand labels are never overwritten by automated ones.

### The human check that is still worth doing

`npm run label` still exists, and it is now a **spot check rather than a shift**: label 50
items, compare against what the automated pass said for the same snippets, and you have a
measured disagreement rate. Three minutes, and it is the only thing that can tell you whether
the automated labels are any good. Without it the whole pipeline is unfalsifiable.

<details>
<summary>The interactive tool, for that spot check</summary>

## 2b. Label by hand

```bash
npm run label     # opens http://localhost:5173
```

| key | means |
|---|---|
| <kbd>F</kbd> | yes, this is the pattern |
| <kbd>J</kbd> | no |
| <kbd>D</kbd> | no — but it IS a different technique |
| <kbd>Space</kbd> | skip |
| <kbd>U</kbd> | undo the last answer |

<kbd>D</kbd> opens a short list: press a digit to name one of the six, or just type a name for
something not on the list and press Enter.

**This is where most of the value comes from.** Yes/no throws away the most informative thing
a person notices — that a snippet is a countdown while they were being asked about stock.
That is a positive example for another pattern, spotted for free, and with nowhere to put it
the answer becomes "no" and the observation is lost. A <kbd>D</kbd> answer is recorded once
and used twice: a negative for the pattern asked about, a positive for the one named.

The free-text box is the other half. It is how a technique the taxonomy does not have — a
checkout donation prompt, a decoy tier, anything nobody wrote down — gets recorded instead of
discarded. `npm run corpus:train` reports what was typed and how often. Every recall failure
this project has had came from a list written in advance; this is the one place you can write
outside it.

Starting over: `npm run label -- --reset` discards every answer and says how many it dropped.

</details>

One item, one keystroke, advances itself. Answers are written to disk immediately — close the
tab whenever, reopen and it resumes at the next unlabelled item.

**Six patterns, ~300 items each.** Only the ones driven by *wording*: scarcity, countdown,
live activity, confirmshaming, spend thresholds and instalments. Reference prices, charm
pricing and preselected options are structural — a strikethrough, a price ending, a ticked
box — so a text model adds nothing to them and they are not worth your time.

**Not everything is shown to you.** The raw corpus is ~95% navigation chrome ("Camp Chairs",
"All Tops"). Items are recruited into three tiers and interleaved:

- **A** — the current lexicon already matches. Fast to confirm, and the only place the
  existing detectors' *false positives* can be found.
- **B** — shares vocabulary with the pattern but does not match. **The valuable tier**: this
  is exactly where recall is being lost.
- **C** — superficially resembles the pattern and almost certainly is not one. Teaches the
  boundary; without these a model trained on A and B calls everything positive.

Interleaved rather than grouped, because forty consecutive obvious noes trains a reflex, and
a reflex mislabels the one that is not obvious.

## 3. Train

```bash
npm run corpus:train
```

Fits one model per pattern and **refuses to emit weights for one that has not earned them**:

- fewer than 40 positives → skipped; a 4096-dimension model with less than that memorises
- held-out precision < 0.80 or recall < 0.50 → rejected

Plan §10 governs over §8 — a detector that cries wolf gets raised or disabled — and there is
no reason a model should be exempt from the rule the hand-written detectors live under.

The held-out split is **by site, not by row**. Splitting rows at random lets the same sentence
land on both sides (retail markup repeats), and the model then scores beautifully on text it
has effectively memorised. A site-wise split asks the only question that matters: does this
work on a shop it has never seen?

Output is `corpus/models.json`. **Nothing is wired into the extension by this step**, and
that is deliberate — see below.

## What is deliberately NOT automatic

**The models do not ship until someone decides they should.** The card's whole promise is
*here is the sentence that triggered this*. A lexicon match points at exact words. A model
score does not — it can say 0.83 and not say why. When these are wired in, they should raise
confidence in findings the lexicons already made rather than surface findings on their own,
or the card ends up asserting something it cannot show you.

`tests/unit/scope.test.ts` asserts no classifier code is in the built bundles today, and that
test should only change when the wiring is a decision rather than an accident.

## Privacy

`corpus/` is gitignored, and should stay that way even after the repo goes public: it holds
real text from real pages, scrubbed but not audited line by line.

`corpus/labels.jsonl` is the expensive artifact — an hour of human judgement that cannot be
regenerated. `candidates.jsonl` can be re-collected any time. **Back the labels up somewhere
outside the repo.**
