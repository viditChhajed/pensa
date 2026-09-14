# Telemetry sink

A single HTTP handler that accepts anonymous prevalence counts and stores **aggregates, not
records**. It is not deployed. Nothing in the extension points at it until
`TELEMETRY_ENDPOINT` in `src/shared/constants.ts` is set.

## What it must do, and why each rule is here rather than in the client

The extension already enforces all of this before sending. The server enforces it again
because **a server that trusts its client is not enforcing anything** — anyone can POST to a
public URL, and the guarantees in PRIVACY.md have to survive that.

| Rule | Why |
|---|---|
| Reject any body that is not an array of the exact seven-field record | The record type is `.strict()` on the client for a reason; an extra field arriving from anywhere is a leak |
| **Never log or store the IP address** | An IP plus an hour bucket plus a site category re-identifies a person. This is the single most important line in the file |
| Aggregate on write, keep no rows | A store of individual records is a store that can be correlated later; a store of counters cannot |
| Drop any cohort below k=20 before it becomes readable | The client holds these back already. The server must assume the client was modified |
| No cookies, no auth, no session | There is nothing to authenticate. An identifier added for "abuse prevention" would defeat the entire design |
| Rate-limit by coarse bucket, not by identity | Abuse control must not become a tracking mechanism |

## Shape

```
POST /api/counts
Content-Type: application/json

{ "v": 1, "records": [
  { "patternId": "scarcity.stock", "detectorId": "scarcity.stock@1",
    "confidenceQuartile": 4, "funnelStage": "pdp",
    "originCategory": "ota_travel", "rulepackVersion": "1", "hourBucket": 486111 }
] }

204 No Content
```

The response carries no body on success, deliberately: anything returned is a channel, and
there is nothing the client needs to know.

## Storage

One table, and it is counters all the way down:

```sql
create table counts (
  pattern_id       text    not null,
  detector_id      text    not null,
  funnel_stage     text    not null,
  origin_category  text    not null,
  rulepack_version text    not null,
  hour_bucket      integer not null,
  quartile         smallint not null,
  n                integer not null default 0,
  reporters        integer not null default 0,
  primary key (pattern_id, detector_id, funnel_stage, origin_category,
               rulepack_version, hour_bucket, quartile)
);
```

`reporters` is incremented once per accepted batch that touches the row, so the k-floor can
be applied at read time as `where reporters >= 20`. There is no reporter id and there is no
way to reconstruct one — the count is of batches, not of people, and that is the strongest
form available without an identifier.

## Deploying

**Cloudflare Workers + D1** — step by step in [DEPLOY.md](DEPLOY.md), about 20 minutes. The
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
