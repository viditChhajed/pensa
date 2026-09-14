# Deploying the telemetry sink — Cloudflare Workers + D1

Roughly 20 minutes. Nothing in the extension contacts this until the last step, and the
extension you have built right now sends nothing at all.

## 1. Create the database

```bash
npm i -g wrangler
wrangler login
wrangler d1 create persuasion-patterns-counts
```

Copy the `database_id` it prints into `server/cloudflare/wrangler.toml`.

## 2. Create the table

```bash
cd server/cloudflare
wrangler d1 execute persuasion-patterns-counts --remote --file=./schema.sql
```

Two objects: a `counts` table whose primary key **is** the cohort — so no row finer-grained
than the anonymity design permits can exist — and a `counts_public` view that hides any
cohort with fewer than 20 reporters. **Read from the view.** A view that is the obvious thing
to query is a better control than a rule somebody has to remember.

## 3. Turn off request logging — do this before deploying, not after

This is the step that matters most, and no code in this repo can do it for you.

Cloudflare records the client IP in its own request logs by default. **An IP beside an hour
bucket and a site category re-identifies a person**, which would quietly undo the entire
design — the handler is careful never to read a header other than `content-type`, and a test
enforces that, but none of it matters if the platform is logging the address anyway.

In the Cloudflare dashboard, for this Worker:

- **Logs → Logpush**: leave disabled.
- **Workers → Observability**: leave disabled (`wrangler.toml` sets this, confirm it held).
- **Analytics**: the aggregate request counts are fine. Do not enable anything per-request.
- Do **not** add an Analytics Engine binding or a tail consumer.

If you later want abuse protection, use Cloudflare's rate limiting rules, which act on a
request without your Worker seeing or storing an identity. Never add one yourself: an
identifier introduced for "abuse prevention" is still an identifier.

## 4. Deploy

```bash
wrangler deploy
```

Note the URL it prints, e.g. `https://persuasion-patterns-counts.<you>.workers.dev`.

## 5. Check it before pointing anything at it

```bash
curl -i -X POST https://<your-worker>/counts \
  -H 'content-type: application/json' \
  -d '{"v":1,"records":[{"patternId":"scarcity.stock","detectorId":"scarcity.stock@1","confidenceQuartile":4,"funnelStage":"pdp","originCategory":"ota_travel","rulepackVersion":"1","hourBucket":'"$(( $(date +%s) / 3600 ))"'}]}'
```

`204` means accepted. Then check it rejects what it should:

```bash
# an extra field -> 422
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-worker>/counts \
  -H 'content-type: application/json' \
  -d '{"v":1,"records":[{"patternId":"scarcity.stock","detectorId":"x","confidenceQuartile":4,"funnelStage":"pdp","originCategory":"ota_travel","rulepackVersion":"1","hourBucket":486111,"origin":"booking.com"}]}'
```

If that returns anything but `422`, stop — the strict check is not running, and the guarantee
in PRIVACY.md is not being enforced.

## 6. Point the extension at it

```bash
TELEMETRY_ENDPOINT=https://<your-worker>/counts npm run build
```

It is a build-time value, so a plain `npm run build` still produces an extension that sends
nothing — which is what the zero-egress tests rely on.

## 7. Then, and only then, update the listing

Ticking the wrong box here is a review failure, and the wording for both cases is already
written in [STORE-LISTING.md](../STORE-LISTING.md):

- [ ] Chrome listing **Data usage disclosures** — switch from "tick nothing" to the collection
      wording, since the shipped build now transmits
- [ ] Re-read the PRIVACY section of the listing copy; it is written to be true either way,
      but read it against what you have actually deployed
- [ ] `npm run test:e2e` — the egress tests assert the only reachable address is the one in
      `TELEMETRY_ENDPOINT`

## Reading the data

```bash
wrangler d1 execute persuasion-patterns-counts --remote \
  --command "select pattern_id, origin_category, sum(n) as seen
             from counts_public group by 1, 2 order by seen desc limit 20"
```

`counts_public`, not `counts`. The floor is applied in the client, again in the handler, and
again here — three times, because each one can be bypassed on its own and the claim in
PRIVACY.md has to survive all three being tried.
