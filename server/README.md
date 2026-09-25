# Prevalence sink

A single HTTP handler that accepts two kinds of report and stores **aggregates, not records**:
per-site prevalence (eight fields) and per-page-view add-to-cart outcomes (seven fields). It is
deployed at `https://pensa-counts.viditchhajed.workers.dev/counts`, backed by the D1 database
`pensa-counts`. Nothing in the extension points at it unless a build sets `TELEMETRY_ENDPOINT`.
Deployment: [DEPLOY.md](DEPLOY.md). Reading the data: `npm run dataset`.

## What it must do, and why each rule is here rather than in the client

The extension already enforces all of this before sending. The server enforces it again
because **a server that trusts its client is not enforcing anything**, anyone can POST to a
public URL, and the guarantees in PRIVACY.md have to survive that.

| Rule | Why |
|---|---|
| Reject any body that is not an array of the exact eight-field prevalence record (v2/v3), plus in v3 an array of the exact seven-field outcome record | Both record types are `.strict()` on the client for a reason; an extra field arriving from anywhere is a leak |
| `site` must be a bare registrable domain | It is the one free-text-shaped column, so it is where a modified client would try to put a URL, a path or an identifier |
| **Never log or store the IP address** | An IP beside a shop name and a day re-identifies a person. This is the single most important line in the file |
| Aggregate on write, keep no rows | A store of individual records is a store that can be correlated later; a store of counters cannot |
| Publish only from `site_prevalence_public` and `site_pattern_add_rate_public` (≥ 20 batches) | Raw per-site counts are for analysis; anything shared outside the project comes from the floored view |
| No cookies, no auth, no session | There is nothing to authenticate. An identifier added for "abuse prevention" would defeat the entire design |
| Rate-limit by coarse bucket, not by identity | Abuse control must not become a tracking mechanism |

## Shape

```
POST /counts
Content-Type: application/json

{ "v": 3,
  "records": [
    { "patternId": "scarcity.stock", "detectorId": "scarcity.stock@1",
      "confidenceQuartile": 4, "funnelStage": "pdp", "site": "shein.com",
      "originCategory": "fast_fashion", "rulepackVersion": "1", "dayBucket": 20712 }
  ],
  "outcomes": [
    { "patternId": "_page", "funnelStage": "pdp", "site": "shein.com",
      "originCategory": "fast_fashion", "rulepackVersion": "1", "dayBucket": 20712,
      "addedToCart": true }
  ]
}

204 No Content
```

`v: 2` is still accepted and means records only. Either array may be empty, but not both, and
the 500-per-batch limit applies to the two together. `patternId: "_page"` is the baseline row
every page view contributes, which is what gives an outcome rate a denominator.

The response carries no body on success, deliberately: anything returned is a channel, and
there is nothing the client needs to know.

## Storage

Two tables of counters plus research views, see [cloudflare/schema.sql](cloudflare/schema.sql),
which is the source of truth. In both, the primary key IS the cohort (for `counts`: technique,
detector, stage, site, category, rulepack, day, quartile; for `outcomes`: technique, stage,
site, category, rulepack, day, and whether the add happened), so no row finer than that can
exist. `reporters` counts accepted batches that touched a row, never people; there is no
reporter id and no way to build one.

The views: `site_prevalence`, `pattern_reach` and `pattern_by_stage` answer how common a
technique is; `pattern_add_rate` and `site_pattern_add_rate` answer how often a page view that
showed one was followed by an add to cart, the latter beside that shop's own baseline. Both
`_public` views apply the 20-batch floor. **The add-rate views measure association, not
effect**, and the comment above them in schema.sql says why.

## Deploying

**Cloudflare Workers + D1**, step by step in [DEPLOY.md](DEPLOY.md), about ten minutes. The
entry point is `cloudflare/worker.ts`, which is deliberately thin: every rule about what may
be accepted lives in `handler.ts`, so the rules are unit-tested without a Worker runtime and
moving host is a change to one file.

`handler.ts` is a plain `(Request) => Response`, the native shape for Cloudflare Workers,
Vercel Edge and Deno Deploy, and three lines from a Node server.

The step that matters most is not in this repo: **turn off Cloudflare's request logging before
deploying.** An IP beside an hour bucket and a site category re-identifies a person, and the
platform records it by default. DEPLOY.md §3.

**Until `TELEMETRY_ENDPOINT` is set at build time the extension sends nothing**, and the
egress tests assert exactly that.
