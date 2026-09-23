/**
 * Cloudflare Worker entry point for the telemetry sink.
 *
 * Thin by design: `handle()` in ../handler.ts holds every rule about what may be accepted,
 * and this file holds only the things that are specific to running on Cloudflare. Keeping
 * them apart is what lets the rules be unit-tested without a Worker runtime, and what makes
 * a move to another host a change to this file alone.
 */
import { type CountRow, handle, type OutcomeRow, type Store } from "../handler";

export interface Env {
  DB: D1Database;
}

/**
 * D1-backed counters. No rows, only totals.
 *
 * A store of individual records can be correlated after the fact, by hour, by category, by
 * anyone who later gains access to it. A store of counters cannot, and the aggregate is the
 * only thing this project ever wanted.
 *
 * `reporters` counts BATCHES that touched the row, never people. There is no reporter id and
 * no way to construct one, which is the strongest form of the k-floor available without
 * introducing exactly the identifier the design exists to avoid.
 */
function d1Store(env: Env): Store {
  return {
    async increment(rows: CountRow[]): Promise<void> {
      /**
       * Collapse the batch to one write per cohort FIRST, and bump `reporters` once per cohort.
       *
       * This used to bind one statement per record, each doing `reporters = reporters + 1`.
       * A single batch of 30 identical reports therefore counted as 30 independent reporters, 
       * found by sending one real batch through the deployed worker and reading back
       * `reporters = 30`. That quietly defeated the publication floor: `site_prevalence_public`
       * releases a shop/technique pair once 20 batches have reported it, and one person's one
       * batch was enough. PRIVACY.md promises "enough independent batches", so the column has
       * to mean batches.
       */
      const cohorts = new Map<string, { row: CountRow; n: number }>();
      for (const r of rows) {
        const key = [
          r.patternId,
          r.detectorId,
          r.funnelStage,
          r.site,
          r.originCategory,
          r.rulepackVersion,
          r.dayBucket,
          r.quartile,
        ].join("\u0000");
        const hit = cohorts.get(key);
        if (hit) hit.n++;
        else cohorts.set(key, { row: r, n: 1 });
      }

      const statement = env.DB.prepare(
        `insert into counts (pattern_id, detector_id, funnel_stage, site, origin_category,
                             rulepack_version, day_bucket, quartile, n, reporters)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         on conflict (pattern_id, detector_id, funnel_stage, site, origin_category,
                      rulepack_version, day_bucket, quartile)
         do update set n = n + excluded.n, reporters = reporters + 1`,
      );

      // One batch, so a partial write cannot leave the aggregate inconsistent.
      await env.DB.batch(
        [...cohorts.values()].map(({ row: r, n }) =>
          statement.bind(
            r.patternId,
            r.detectorId,
            r.funnelStage,
            r.site,
            r.originCategory,
            r.rulepackVersion,
            r.dayBucket,
            r.quartile,
            n,
          ),
        ),
      );
    },

    /** Same collapse-then-write as `increment`, and for the same reason: `reporters` counts batches. */
    async incrementOutcomes(rows: OutcomeRow[]): Promise<void> {
      const cohorts = new Map<string, { row: OutcomeRow; n: number }>();
      for (const r of rows) {
        const key = [
          r.patternId,
          r.funnelStage,
          r.site,
          r.originCategory,
          r.rulepackVersion,
          r.dayBucket,
          r.addedToCart ? 1 : 0,
        ].join("\u0000");
        const hit = cohorts.get(key);
        if (hit) hit.n++;
        else cohorts.set(key, { row: r, n: 1 });
      }

      const statement = env.DB.prepare(
        `insert into outcomes (pattern_id, funnel_stage, site, origin_category, rulepack_version,
                               day_bucket, added_to_cart, n, reporters)
         values (?, ?, ?, ?, ?, ?, ?, ?, 1)
         on conflict (pattern_id, funnel_stage, site, origin_category, rulepack_version,
                      day_bucket, added_to_cart)
         do update set n = n + excluded.n, reporters = reporters + 1`,
      );

      await env.DB.batch(
        [...cohorts.values()].map(({ row: r, n }) =>
          statement.bind(
            r.patternId,
            r.funnelStage,
            r.site,
            r.originCategory,
            r.rulepackVersion,
            r.dayBucket,
            r.addedToCart ? 1 : 0,
            n,
          ),
        ),
      );
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    /**
     * CORS preflight. The extension posts from a `chrome-extension://` origin, which is
     * opaque and cannot be allowlisted by name.
     *
     * `*` is correct here and is not a weakening: there is nothing to protect. The endpoint
     * accepts anonymous counters, holds no session, sets no cookie, returns no body, and
     * reads nothing back. A same-origin policy defends a user's authenticated state, and
     * there is none, the request carries `credentials: "omit"` from the client precisely so
     * that stays true.
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname !== "/counts") return new Response(null, { status: 404 });

    const response = await handle(request, d1Store(env));
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", "*");
    return new Response(response.body, { status: response.status, headers });
  },
};

/** Minimal D1 surface, so this compiles without pulling in @cloudflare/workers-types. */
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
}
