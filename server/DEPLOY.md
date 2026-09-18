# Deploying the prevalence sink — Cloudflare Workers + D1

About ten minutes. Everything runs from the repo root. Nothing in the extension contacts this
until step 6, and a plain `npm run build` still produces an extension that sends nothing.

## 1. Log in (once)

```bash
npx wrangler login
```

This opens a browser for Cloudflare's own sign-in. It is the one step that has to be done by
the account owner.

## 2. Create the database

```bash
npx wrangler d1 create vero-counts
```

Copy the `database_id` it prints into `server/cloudflare/wrangler.toml`, replacing
`PUT-YOUR-D1-DATABASE-ID-HERE`.

## 3. Create the table and the research views

```bash
npm run sink:schema
```

This creates `counts` — whose primary key **is** the cohort (site, technique, stage, day…), so
no row finer than that can exist — plus four views: `site_prevalence`, `pattern_reach`,
`pattern_by_stage`, and `site_prevalence_public`. **Anything you publish comes from
`site_prevalence_public`**, which only releases a shop/technique pair once 20 independent
batches have reported it.

Version 3 adds an `outcomes` table (add-to-cart outcomes per technique, with a `_page`
baseline per view) and three views: `pattern_add_rate`, `site_pattern_add_rate` (each
technique's add rate beside its shop's baseline, and the `lift` between them), and
`site_pattern_add_rate_public`, floored the same way. These measure association, not effect;
the comment on `pattern_add_rate` in schema.sql says why. The schema file is safe to re-run on
an existing database: every statement is `create … if not exists`.

## 4. Confirm request logging is off — before deploying

The service never reads a header other than `content-type` (a unit test enforces it). That is
worth nothing if the platform logs the address anyway, and **an IP beside a shop name and a
day re-identifies a person.**

- `server/cloudflare/wrangler.toml` sets `[observability] enabled = false`, which keeps
  Workers Logs off. After deploying, confirm in the dashboard: **Workers → vero-counts →
  Observability** shows disabled.
- **Logpush**: leave disabled.
- Do **not** add an Analytics Engine binding, a tail consumer, or `wrangler tail` sessions
  left running.
- Aggregate request counts in the dashboard are fine; nothing per-request.

PRIVACY.md states that per-request logging is off. If any of the above is on, that sentence is
false.

## 5. Deploy

```bash
npm run sink:deploy
```

Note the URL, e.g. `https://vero-counts.<you>.workers.dev`.

## 6. Check it accepts what it should and refuses what it must

```bash
W=https://vero-counts.<you>.workers.dev
DAY=$(( $(date +%s) / 86400 ))
GOOD='{"patternId":"scarcity.stock","detectorId":"scarcity.stock@1","confidenceQuartile":4,"funnelStage":"pdp","site":"shein.com","originCategory":"fast_fashion","rulepackVersion":"1","dayBucket":'$DAY'}'
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/counts" -H 'content-type: application/json' -d '{"v":2,"records":['"$GOOD"']}'
```

Must print `204`. Then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/counts" -H 'content-type: application/json' -d '{"v":2,"records":[{"patternId":"scarcity.stock","detectorId":"x","confidenceQuartile":4,"funnelStage":"pdp","site":"shein.com/p/123","originCategory":"fast_fashion","rulepackVersion":"1","dayBucket":'$DAY'}]}'
```

Must print `422` — a path in `site`. If it prints anything else, **stop**: the strict check is
not running and PRIVACY.md is not being enforced. Delete the test row afterwards:

```bash
npx wrangler d1 execute vero-counts --remote --config server/cloudflare/wrangler.toml --command "delete from counts where detector_id in ('scarcity.stock@1','x') and site = 'shein.com' and n <= 1"
```

## 7. Point the extension at it

```bash
TELEMETRY_ENDPOINT=https://vero-counts.<you>.workers.dev/counts npm run build && npm run zip
```

Build-time only. Upload **that** zip — a zip from a plain `npm run build` sends nothing.

## 8. Update the listing to match

In the Chrome Web Store dashboard, **Privacy practices → Data usage**: tick **Web history**
(the shop's domain is browsing activity) and certify it is used for the product's stated
purpose, not sold, not used for creditworthiness. The wording is in STORE-LISTING.md.

## Reading the data

```bash
npm run dataset                              # per-site prevalence -> dataset/
npm run dataset -- --view pattern_reach      # how many shops use each technique
npm run dataset -- --view pattern_by_stage   # where in the funnel
npm run dataset -- --public                  # only the publishable cut
npm run dataset -- --sql "select * from site_prevalence where site = 'shein.com'"
```

There is no read endpoint on the worker, deliberately. The only way into the data is through
the Cloudflare account that owns it.
