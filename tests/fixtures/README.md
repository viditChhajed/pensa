# Fixture capture protocol

Fixtures are the regression net (plan §10). They come from **real retailer pages**, which is
what makes them useful and what makes the scrub non-optional.

## Capture

In DevTools on the target page:

```js
copy(document.documentElement.outerHTML)
```

Use SingleFile instead when a detector depends on inlined CSS — `interference.visual_asymmetry`
and `pricing.charm`'s cents sizing. Plain `outerHTML` is preferred everywhere else: it diffs
legibly and stays small.

For `urgency.countdown` and `social_proof.live_activity`, capture **two** snapshots ~3s apart.
The signal is the mutation; a single frozen frame cannot express it.

Capture **signed out** wherever the detector does not need a cart.

## Naming

```
tests/fixtures/<detectorId>/<pos|neg>/<slug>.html
tests/fixtures/<detectorId>/<pos|neg>/<slug>.meta.json
```

The `.meta.json` records `{ capturedAt, funnelStage, expectedPatternIds, note, sourceCategory }`.
`sourceCategory` only — the origin is deliberately **not** recorded in committed metadata.

## Normalise and scrub — before every commit

```bash
npm run fixtures:normalize -- tests/fixtures/<path>.html
```

This strips scripts (keeping `application/ld+json`, which detectors parse), removes inline
event handlers, makes remote references inert, collapses oversized base64 images, freezes
future epochs so countdown fixtures are deterministic, and redacts PII.

It prints every redaction. **Read that list, and read the diff.** The regexes are a first
pass, not a guarantee.

## CI gate

```bash
npm run fixtures:scan
```

Fails the build if any committed fixture still matches a PII pattern, so a fixture added
without normalising cannot merge.

Every placeholder is shaped so it cannot match the rule that produced it — `scrub` is
idempotent and there is a test asserting it. This matters: `4111 1111 1111 1111` is itself a
Luhn-valid card number, so using it as the card placeholder would make every correctly
scrubbed fixture fail the gate forever, and the first response to that would be to switch the
gate off.

## Coverage bar

At least 3 positive and 3 negative snapshots per detector. **The negatives matter more.**
For `scarcity.stock`, include a page saying "2 sizes left" as genuine variant availability —
that is the exact false positive the plan warns will cause uninstalls.
